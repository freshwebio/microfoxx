'use strict';

const sessionsMiddleware = require('@arangodb/foxx/sessions');

// Create a session middleware to store session data and authorise client connections
// through standard username and password authentication.
const sessions = sessionsMiddleware({
  storage: module.context.collection('dbsession'),
  transport: ['header']
});

// Now enable the middleware for this service.
module.context.use(sessions);

const createAuth = require('@arangodb/foxx/auth');
const createRouter = require('@arangodb/foxx/router');
const JCursor = require('./utility/jcursor');

const router = createRouter();
const auth = createAuth();
const users = module.context.collection('dbuser');
const cursors = module.context.collection('dbcursor');

const db = require('@arangodb').db;
const graph_module = require('@arangodb/general-graph');
const errors = require('@arangodb').errors;
const DOC_NOT_FOUND = errors.ERROR_ARANGO_DOCUMENT_NOT_FOUND.code;
const aql = require('@arangodb').aql;
const joi = require('joi');
const eventsColl = module.context.collection('dbevent');
module.context.use(router);

/**
 * Middleware used for every route to authenticate access to endpoints using a session ID
 * provided in the header as X-Session-Id.
 * A user must be authenticated for every endpoint apart from /login.
 * TODO: At some point use JWT instead of server-managed sessions.
 */
module.context.use({
  register(endpoint) {
    endpoint.header('x-session-id', joi.string().optional(), 'The session ID');
    return function(req, res, next) {
      if (req.path === '/login') {
        next();
      } else {
        // Now ensure that the current user is authenticated to access other endpoints.
        if (req.session.uid !== null) {
          var user = users.document(req.session.uid);
          if (user !== null) {
            next();
          } else {
            res.throw(401, 'Unauthenticated');
          }
        } else {
          res.throw(401, 'Unauthenticated');
        }
      }
    }
  }
});

router.post('/login', function(req, res) {
    // First retrieve our user from the username index.
    const user = users.firstExample({
      username: req.body.username
    });
    if (user) {
      const valid = auth.verify(user.authData, req.body.password);
      if (!valid) res.throw('unauthorised');
      // Now log our user in.
      req.session.uid = user._key;
      var meta = req.sessionStorage.save(req.session);
      res.send({sid: meta._key, uid: meta.uid});
    } else {
      res.throw(400, 'The provided username couldn\'t be found in the database.');
    }
  })
  .body(joi.object({
    username: joi.string().required(),
    password: joi.string().required()
  }).required(), 'Credentials')
  .description('Logs a registered user in to the database service.');

router.post('/logout', function(req, res) {
    if (req.session.uid) {
      req.session.uid = null;
      req.sessionStorage.save(req.session);
    }
    res.send({success: true});
  })
  .description('Logs the current user out of the service.');

// Create our collection regular expression to ensure the events collection name
// is not an accepted path parameter.
// The downside to doing it this way is that no other collections can contain the name of
// the events collection.
var collre = new RegExp('^(?!.*juntos_dbevent).*$','i');

/**
 * Deals with creating a new document in the provided collection
 * and also populating an event to accompany the newly created document.
 */
router.post('/:coll', function(req, res) {
    // First of all ensure there is a collection that exists with
    // the provided path parameter.
    const coll = db._collection(req.pathParams.coll);
    if (coll !== null) {
      // Try to create the provided document in the specified collection
      // and add a new event within the same transaction.
      try {
        const respData = db._executeTransaction({
          collections: {
            write: [req.pathParams.coll, 'juntos_dbevent']
          },
          action: function () {
            var item = coll.save(req.body);
            var doc = Object.assign(req.body, item);
            // Add a serialised version of the item we just saved to be stored as part of the event.
            // TODO: This should probably use a more efficient storage/on-the-write format than JSON for data.
            const eventData = {type: req.pathParams.coll, op: 'create', data: JSON.stringify(doc), created: Date.now()};
            var evt = eventsColl.save(eventData);
            return {
              doc: doc,
              event: Object.assign(eventData, evt)
            };
          }
        });
        // Return the newly created item with it's ID and the newly created event
        // if the whole transaction is successful.
        res.send(respData);
      } catch (e) {
        res.throw(400, e.message);
      }
    }
    else {
      res.throw(400, 'The provided collection couldn\'t be found in the data store.');
    }
  })
  .body(joi.object().required(), 'The request body is expected to be a JSON object.')
  .response(['application/json'])
  .pathParam('coll', joi.string().regex(collre), 'The collection to add the document to which cannot contain the events collection name as is reserved.')
  .summary('Create a document in collection')
  .description('Saves a new document to the collection given the collection exists, ' +
    'in the case the collection is not the events dedicated collection as specified by an environment ' +
    'variable. This will also create a new event that gets sent back as a part ' +
    'of the response so the client can carry out any event publishing required to synchronise other services.');

/**
 * Deals with retrieving all the documents in a provided
 * collection. Filtering can be done by providing query parameters for
 * document fields.
 * The GET method for collections also allows for retrieval of events
 * unlike the POST method as events should only ever be created as a part of an atomic
 * transaction when CRUD operations occur for other collections but can be retrieved in order
 * for services to ensure they are up to date with each other where events may have been missed.
 */
router.get('/:coll', function(req, res) {
    // Where there are no query parameters provided simply retrieve
    // all documents in the provided collection.
    const coll = db._collection(req.pathParams.coll);
    if (coll !== null) {
      if (Object.keys(req.queryParams).length === 0) {
        const items = db._query(aql`FOR item IN ${coll} RETURN item`);
        res.send(items);
      } else {
        // Deal with filtering by the query parameters.
        // First of all we need to extract sort and limit query parameters
        // if provided to differentiate from document properties.
        var params = Object.assign({}, req.queryParams);
        var query = 'FOR item IN @@coll ';
        var bindVars = {'@coll': req.pathParams.coll};
        var sort = '';
        var limit = '';
        var filters = '';

        // First handle generating and validating the sort part of our query
        // if a sort query parameter is provided.
        if (params.hasOwnProperty('sort')) {
          // Deal with parsing the sort string.
          var fields;
          // Make the default order descending order.
          var order = 'DESC';
          if (params.sort.includes('::')) {
            const parts = params.sort.split('::');
            const fieldsStr = parts[0];
            fields = fieldsStr.split(',');
            order = parts[1];
            sort = '\nSORT ';
          } else {
            fields = params.sort.split(',');
          }
          for (var i = 0; i < fields.length; i++) {
            // Ensure that the field is only made up of letters, numbers and underscores.
            if (/[a-zA-Z0-9_]+/i.test(fields[i])) {
              sort += 'item.' +  fields[i];
              if (i < fields.length - 1) {
                sort += ', ';
              }
            } else {
              res.throw(400, 'Sort fields can only be formed of underscores, letters and digits.');
            }
          }
          sort += ' ' + order + ' ';
          delete params.sort;
        }

        // Now handle the limit part of the AQL query.
        if (params.hasOwnProperty('limit')) {
          // Ensure the limit is either a number or two numbers separated by a comma.
          if (/^(\d+)$|^(\d+,\s*\d+)$/g.test(params.limit)) {
            limit += '\nLIMIT ' + params.limit;
          } else {
            res.throw(400, 'Limit field must be a number or two numbers separated by a comma like "10" or "0, 3"');
          }
          // If we get to this point remove limit from params.
          delete params.limit;
        }

        // Now handle all the other query parameters that will be added as item.[property] = @val{n} filters to the query.
        var paramKeys = Object.keys(params);
        filters += '\nFILTER ';
        for (var j = 0; j < paramKeys.length; j++) {
          var key = paramKeys[j];
          // Ensure our key is made up of word characters [a-zA-Z0-9_] or \w for short.
          if (/^\w+$/i.test(key)) {
            filters += 'item.' + key + ' == @val' + j + (j < paramKeys.length - 1 ? ' &&' : '');
            bindVars['val' + j] = params[key];
          } else {
            res.throw(400, 'Field key properties are expected to be made up of only word characters. ([a-zA-Z0-9_])');
          }
        }

        query += filters + sort + limit + ' \nRETURN item';
        var result = db._query(query, bindVars);
        res.send(result);
      }
    } else {
      res.throw(400, 'The provided collection couldn\'t be found in the data store.');
    }
  })
  .response(['application/json'])
  .summary('Retrieve documents from the collection')
  .pathParam('coll', joi.string(), 'The collection to retrieve documents from, this must exist in the database.')
  .description('Attempts to retrieve a set of documents from the provided collection. You can provide field values as query parameters. ' +
    'If you need to query a collection that checks other things than just whether fields equal values you should use the /query endpoint with bindVars as query parameters.\n' +
    'You can provide a sort query parameter where the form expected is [field1],[field2],...[::order?] and a limit query parameter which can be [limit] or [offset], [count].');

/**
 * Deals with retrieving the amount of documents in the provided collection.
 * Query parameters can be provided to filter by properties.
 */
router.get('/:coll/count', function(req, res) {
    const coll = db._collection(req.pathParams.coll);
    if (coll !== null) {
      var paramKeys = Object.keys(req.queryParams);
      var result;
      if (paramKeys.length === 0) {
        // Retrieve the amount of items in the collection.
        result = db._query(aql`FOR item IN ${coll} COLLECT WITH COUNT INTO length RETURN length`);
        res.send({count: result._documents[0]});
      } else {
        var bindVars = {'@coll': req.pathParams.coll};
        var query = 'FOR item IN @@coll FILTER ';
        // Now take each query parameter and ensure the key is a valid format then attach as a filter.
        for (var i = 0; i < paramKeys.length; i++) {
          var key = paramKeys[i];
          if (/^\w+$/i.test(key)) {
            query += 'item.' + key +  ' == @val' + i + (i < paramKeys.length -1 ? ' && ' : ' ');
            bindVars['val' + i] = req.queryParams[key];
          } else {
            res.throw(400, 'Field key properties are expected to be made up of only word characters. ([a-zA-Z0-9_])');
          }
        }
        query += 'RETURN LENGTH(@@coll)';
        result = db._query(query, bindVars);
        res.send({count: result._documents[0] || 0});
      }
    } else {
      res.throw(400, 'The provided collection couldn\'t be found in the data store.');
    }
  })
  .response(['application/json'])
  .summary('Retrieve the amount of items in the collection.')
  .pathParam('coll', joi.string(), 'The collection to get the amount of documents for.')
  .description('Retrieves the amount of documents in the specified collection where no query parameters are provided.' +
    ' If query parameters are provided they will be used as property filters that get added to the query so the count will be the amount ' +
    'of documents in the collection with the provided property values.');

router.get('/:coll/:key', function(req, res) {
    const coll = db._collection(req.pathParams.coll);
    if (coll !== null) {
      try {
        var doc = coll.document(req.pathParams.key);
        res.send(doc);
      } catch (e) {
        if (!e.isArangoError || e.errorNum !== DOC_NOT_FOUND) {
          throw e;
        }
        res.throw(404, 'The document does not exist in the provided collection.', e);
      }
    } else {
      res.throw(400, 'The provided collection couldn\'t be found in the data store.');
    }
  })
  .response(['application/json'])
  .summary('Retrieve the document in the provided collection with the given key.')
  .pathParam('coll', joi.string(), 'The collection to retrieve the document from.')
  .pathParam('key', joi.string(), 'The unique key of the document to be retrieved.')
  .description('Retrieve the document in the provided collection with the given key');

/**
 * Deals with updating the item with the provided key in the specified collection.
 */
router.put('/:coll/:key', function(req, res) {
    const coll = db._collection(req.pathParams.coll);
    if (coll !== null) {
      try {
        const respData = db._executeTransaction({
          collections: {
            write: [req.pathParams.coll, 'juntos_dbevent']
          },
          action: function () {
            var item = coll.update(req.pathParams.key, req.body);
            var doc = Object.assign(req.body, item);
            const eventData = {type: req.pathParams.coll, op: 'update', data: JSON.stringify(doc), created: Date.now()};
            var evt = eventsColl.save(eventData);
            return {
              doc: doc,
              event: Object.assign(eventData, evt)
            };
          }
        });
        // Return the newly created item with it's ID and the newly created event
        // if the whole transaction is successful.
        res.send(respData);
      } catch (e) {
        res.throw(400, e.message);
      }
    } else {
      res.throw(400, 'The provided collection could not be found in the data store.');
    }
  })
  .response(['application/json'])
  .body(joi.object().required(), 'The request body is expected to be a JSON object.')
  .summary('Update the document in the provided collection with the given key.')
  .pathParam('coll', joi.string(), 'The collection to update the document in.')
  .pathParam('key', joi.string(), 'The unique key of the document to be updated.')
  .description('Update the document in the provided collection with the given key');

/**
 * Removes the document with the given key from the provided collection if it exists
 * in the collection. (Also handles removal of all references to the document)
 */
router.delete('/:coll/:key', function(req, res) {
    const coll = db._collection(req.pathParams.coll);
    if (coll !== null) {
      try {
        const respData = db._executeTransaction({
          collections: {
            write: [req.pathParams.coll, 'juntos_dbevent']
          },
          action: function () {
            var result = coll.remove(req.pathParams.key, {returnOld: true});
            const eventData = {type: req.pathParams.coll, op: 'delete', data: JSON.stringify(result.old), created: Date.now()};
            var evt = eventsColl.save(eventData);
            return {
              doc: result.old,
              event: Object.assign(eventData, evt)
            };
          }
        });
        // Return the newly created item with it's ID and the newly created event
        // if the whole transaction is successful.
        res.send(respData);
      } catch (e) {
        res.throw(400, e.message);
      }
    } else {
      res.throw(400, 'The provided collection could not be found in the data store.');
    }
  })
  .response(['application/json'])
  .summary('Remove the document from the provided collection with the given key.')
  .pathParam('coll', joi.string(), 'The collection to remove the document from.')
  .pathParam('key', joi.string(), 'The unique key of the document to be removed.')
  .description('Remove the document from the provided collection with the given key');

/**
 * Deals with returning the results for the provided AQL query where any bind parameters
 * are expected to be provided as part of the request body as well.
 * This endpoint can be used for retrieval and modification.
 * This essentially mirrors the arangodb HTTP API method for AQL queries though has only been created
 * so far to support select queries and not document modifying queries due to the level of control
 * needed in order to ensure events are created for every modifying/inserting operation.
 */
router.post('/cursor', function(req, res) {
  var stmt = db._createStatement({
    query: req.body.query,
    bindVars: req.body.bindVars,
    count: true
  });
  var cursor = stmt.execute();
  // Where the batch size is more than or equal to the result set.
  var body;
  if (cursor.count() <= req.body.batchSize) {
    body = {results: cursor.toArray(), hasMore: false};
    if (req.body.count) {
      body.count = cursor.count();
    }
    res.send(body);
  } else {
    // Iterate until we've reached the batch limit to return the first batch.
    var batch = [];
    var i = 0;
    const batchSize = req.body.batchSize;
    while (cursor.hasNext() && i < batchSize) {
      batch.push(cursor.next());
      i++;
    }
    // Now persist our cursor to be retrieved later on from the dedicated cursor collection.
    var cMeta = cursors.save(Object.assign(cursor, {_created: Date.now(), _batchSize: batchSize}));
    // Pass the cursor key to our response body to be used by the client.
    body = {results: batch, cursor: cMeta._key, hasMore: true};
    if (req.body.count) {
      body.count = cursor.count();
    }
    res.send(body);
  }
}).response(['application/json'])
  .summary('Run an AQL query to retrieve documents.')
  .description('Run an AQL query directly to retrieve documents, graph edges ' +
    'and vertices or anything else available to query in the ArangoDB database. This endpoint has only been built to support select queries, ' +
    'for modifying/insertion queries use /insert, /update and /remove endpoints.')
  .body(joi.object().keys({
    query: joi.string().required(),
    bindVars: joi.object(),
    batchSize: joi.number().default(1),
    count: joi.boolean().default(false)
  }));

/**
 * Deals with retrieving the next batch from the cursor with the provided ID.
 * This is used when you use /cursor to run a batch query and need to get the next batch.
 * This provides a response with a hasMore property to determine if there are more batches
 * to retrieve.
 */
router.put('/cursor/:cid', function(req, res) {
    var cursor = cursors.document(req.pathParams.cid);
    const batchSize = cursor._batchSize;
    var jcursor = new JCursor(cursor);
    var batch = [];
    var i = cursor._current;
    var limit = cursor._current + batchSize;
    while (jcursor.hasNext() && i < limit) {
      batch.push(jcursor.next());
      i++;
    }
    // In the case we have reached the end remove the cursor from the collection
    // and let the client know there are no more items left to consume.
    if (!jcursor.hasNext()) {
      // Remove our cursor from the collection.
      cursors.remove(cursor._key);
      res.send({results: batch, hasMore: false});
    } else {
      // Update our cursor to the new state (updated current position in the result set).
      cursors.update(jcursor.cursorData._key, jcursor.cursorData);
      res.send({results: batch, hasMore: true});
    }
  })
  .response(['application/json'])
  .summary('Used to retrieve the next batch from the provided cursor.')
  .description('This is to be used by a client which started a batch operation with a cursor.')
  .pathParam('cid', joi.string(), 'The unique ID of the cursor to retrieve the next batch from.');

/**
 * Deals with running an insert query and creating events for each inserted item
 * within a single transaction. This meaning if something goes wrong with inserting items
 * or creating events, everything within the transaction is disregarded.
 */
router.post('/insert', function(req, res) {
    // First of all ensure the query contains the INSERT keyword and not UPDATE or
    // REMOVE. This is fairly loose checking as we'll simply let ArangoDB handle whether or not
    // the query is actually valid.
    var query = req.body.query;
    if (query.includes('INSERT') && !query.includes('REMOVE') && !query.includes('UPDATE')) {
      // Now in the case the query doesn't already end with RETURN {word}
      // then add RETURN NEW to ensure we get the newly created items.
      if (!/'RETURN\s+\w+$'/g.test(query.trim())) {
        query += ' RETURN NEW';
      }
      // Now run the query within a transaction so we can create an event for all newly inserted
      // items in an atomic way.
      try {
        const respData = db._executeTransaction({
          collections: {
            write: [req.body.writeCollection, 'juntos_dbevent'],
            read: req.body.readCollections
          },
          action: function () {
            var stmt = db._createStatement({
              query: query,
              bindVars: req.body.bindVars,
              count: true
            });
            const cursor = stmt.execute();
            var events = [];
            var docs = [];
            while (cursor.hasNext()) {
              const newItem = cursor.next();
              const eventData = {
                type: req.body.writeCollection,
                op: 'create',
                data: JSON.stringify(newItem),
                created: Date.now()
              };
              var evt = eventsColl.save(eventData);
              events.push(Object.assign(eventData, evt));
              docs.push(newItem);
            }
            return {
              docs: docs,
              events: events
            };
          }
        });
        // Now send the response of the transactions action callback.
        res.send(respData);
      } catch(e) {
        res.throw(400, e.message);
      }
    } else {
      res.throw(400, 'Only insert queries should be provided to the /insert endpoint.');
    }
  })
  .response(['application/json'])
  .summary('Run an AQL insert query.')
  .description('Run a query that will insert items into collections. Only insert queries should be provided via this endpoint.' +
    ' The collections involved in the query must also be explicitly defined in the request body in order to setup the transaction with the correct read and write permissions.')
  .body(joi.object().keys({
    writeCollection: joi.string().required(),
    readCollections: joi.array().items(joi.string()).required(),
    query: joi.string().required(),
    bindVars: joi.object()
  }));

/**
 * Deals with running an update query and creating events for each updated item.
 * Currently there is no support for UPSERT only separate INSERT and UPDATE and select queries.
 */
router.post('/update', function(req, res) {
    var query = req.body.query;
    if (query.includes('UPDATE') && !query.includes('INSERT') && !query.includes('REMOVE')) {
      // Now in the case the query doesn't already end with a RETURN statement
      // then add RETURN { before: OLD, after: NEW } to return the modified and unmodified versions of the document.
      if (!/'RETURN\s+\w+$'/g.test(query.trim())) {
        query += ' RETURN { before: OLD, after: NEW }';
      }
      // Now run the query within a transaction so we can create an event for all the updated
      // items.
      try {
        const respData = db._executeTransaction({
          collections: {
            write: [req.body.writeCollection, 'juntos_dbevent'],
            read: req.body.readCollections
          },
          action: function () {
            var stmt = db._createStatement({
              query: query,
              bindVars: req.body.bindVars,
              count: true
            });
            const cursor = stmt.execute();
            var events = [];
            var docs = [];
            while (cursor.hasNext()) {
              const updatedItem = cursor.next();
              const eventData = {
                type: req.body.writeCollection,
                op: 'update',
                // Add the before and after values to our event to allow clients
                // to see the difference that was made by this event.
                data: JSON.stringify(updatedItem),
                created: Date.now()
              };
              var evt = eventsColl.save(eventData);
              events.push(Object.assign(eventData, evt));
              // Push the object containing both the previous and new value
              // for each document.
              docs.push(updatedItem);
            }
            return {
              docs: docs,
              events: events
            };
          }
        });
        // Now send the response of the transactions action callback.
        res.send(respData);
      } catch(e) {
        res.throw(400, e.message);
      }
    }
  })
  .response(['application/json'])
  .summary('Run an AQL update query.')
  .description('Run a query that will update documents. Only update queries should be provided via this endpoint.' +
    ' The collections involved in the query must also be explicitly defined in the request body in order to setup the transaction with the correct read and write permissions.')
  .body(joi.object().keys({
    writeCollection: joi.string().required(),
    readCollections: joi.array().items(joi.string()).required(),
    query: joi.string().required(),
    bindVars: joi.object()
  }));

/**
 * Deals with running a remove query and creating events for each item that is removed.
 */
router.post('/remove', function(req, res) {
    var query = req.body.query;
    if (query.includes('REMOVE') && !query.includes('INSERT') && !query.includes('UPDATE')) {
      // Now in the case the query doesn't already end with a RETURN statement
      // then add RETURN OLD to return the document that was removed.
      if (!/'RETURN\s+\w+$'/g.test(query.trim())) {
        query += ' RETURN OLD';
      }
      // Now run the query within a transaction so we can create an event for all the updated
      // items.
      try {
        const respData = db._executeTransaction({
          collections: {
            write: [req.body.writeCollection, 'juntos_dbevent'],
            read: req.body.readCollections
          },
          action: function () {
            var stmt = db._createStatement({
              query: query,
              bindVars: req.body.bindVars,
              count: true
            });
            const cursor = stmt.execute();
            var events = [];
            var docs = [];
            while (cursor.hasNext()) {
              const removedItem = cursor.next();
              const eventData = {
                type: req.body.writeCollection,
                op: 'delete',
                // Add the removed document to the event.
                data: JSON.stringify(removedItem),
                created: Date.now()
              };
              var evt = eventsColl.save(eventData);
              events.push(Object.assign(eventData, evt));
              // Push the object containing both the previous and new value
              // for each document.
              docs.push(removedItem);
            }
            return {
              docs: docs,
              events: events
            };
          }
        });
        // Now send the response of the transactions action callback.
        res.send(respData);
      } catch (e) {
        res.throw(400, e.message);
      }
    }
  })
  .response(['application/json'])
  .summary('Run an AQL remove query.')
  .description('Run a query that will remove documents from a collection. Only remove queries should be provided via this endpoint.' +
    ' The collections involved in the query must also be explicitly defined in the request body in order to setup the transaction with the correct read and write permissions.')
  .body(joi.object().keys({
    writeCollection: joi.string().required(),
    readCollections: joi.array().items(joi.string()).required(),
    query: joi.string().required(),
    bindVars: joi.object()
  }));

/**
 * Create a new document collection.
 */
router.post('/collection', function(req, res) {
    // Attempt to create our new collection.
    // an error is thrown in the case the collection already exists
    // or something goes wrong in creating the collection.
    var meta = db._create(req.body.name);
    meta.message = 'Successfully created the new ' + req.body.name + ' collection.';
    res.send(Object.assign(req.body, meta));
  })
  .response(['application/json'])
  .summary('Create a new collection in the database')
  .description('Deal with creating a new document collection if the one with the collection doesn\'t already exist.')
  .body(joi.object().keys({
    name: joi.string().required()
  }).required(), 'The request body is expected to be a JSON object containing the collection name.');

/**
 * Create a new graph with vertex and edge definitions.
 */
router.post('/graph', function(req, res) {
    var graph = graph_module._create(req.body.name);
    // Now add the relations to the graph.
    for (var i = 0; i < req.body.relations.length; i++) {
      var relDef = req.body.relations[i];
      var relation = graph_module._relation(relDef.name, relDef.from, relDef.to);
      graph._extendEdgeDefinitions(relation);
    }
    res.send({message: 'Successfully created the new ' + req.body.name + ' graph.'});
  })
  .response(['application/json'])
  .summary('Create a new graph with edge and vertex collections.')
  .description('Create a new graph with the graph definition provided in the request body.')
  .body(joi.object().keys({
    name: joi.string().required(),
    relations: joi.array().items(joi.object().keys({
      name: joi.string(),
      from: joi.array().items(joi.string()),
      to: joi.array().items(joi.string())
    })),
    orphans: joi.array().items(joi.string())
  }).required(), 'The graph definition object.');

/**
 * Create a new edge definition or relation for the provided graph which then deals with
 * creating the vertex collections
 * that are needed if they don't already exist alongside the new edge collection.
 */
router.post('/graph/:graph/relation', function(req, res) {
    var graph = graph_module._graph(req.pathParams.graph);
    var relation = graph_module._relation(req.body.name, req.body.from, req.body.to);
    graph._extendEdgeDefinitions(relation);
    res.send({message: 'New relation successfully added to the edge definitions for the ' + req.pathParams.graph + ' graph.'});
  })
  .response(['application/json'])
  .summary('Create a new relation for the specified graph.')
  .description('Deals with creating a new edge definition between two sets of vertex collections.')
  .pathParam('graph', joi.string(), 'The name of the graph to add the relation to.')
  .body(joi.object().keys({
    name: joi.string(),
    from: joi.array().items(joi.string()),
    to: joi.array().items(joi.string())
  }), 'The relation definition object.');

/**
 * Retrieve the user created indexes on a specified collection in the data store.
 */
router.get('/index/:coll', function(req, res) {
  const coll = db._collection(req.pathParams.coll);
  var indexes = coll.getIndexes();
  res.send(indexes);
}).response(['application/json'])
  .summary('Retrieve indexes')
  .description('Retrieve the indexes on the data store. This excludes arango\'s internally managed indexes.')
  .pathParam('coll', joi.string(), 'The collection to retrieve indexes for.');

/**
 * Create a new index for the provided fields of the specified type
 * with extra parameters to be passed through to the underlying database
 * to create the new index.
 */
router.post('/index', function(req, res) {
  const coll = db._collection(req.body.collection);
  delete req.body.collection;
  var indexInfo = coll.ensureIndex(req.body);
  res.send(indexInfo);
}).response(['application/json'])
  .summary('Create a new index')
  .description('Create a new index with the specified configuration for the provided collection.')
  .body(joi.object().keys({
    collection: joi.string().required(),
    type: joi.string(),
    fields: joi.array().items(joi.string()).required(),
    sparse: joi.boolean(),
    unique: joi.boolean()
  }), 'The parameters to be used to create a new index in the case it doesn\'t already exist');

/**
 * Drop an index from the arangodb data store.
 */
router.delete('/index/:coll/:key', function(req, res) {
  const coll = db._collection(req.pathParams.coll);
  var removed = coll.dropIndex(req.pathParams.coll + '/' + req.pathParams.key);
  if (removed) {
    res.send({message: 'Successfully removed the index specified'});
  } else {
    res.throw(404, 'The specified index could not be found');
  }
}).response(['application/json'])
  .summary('Drop an index')
  .description('Drop an index with the provided collection and key handle combination.')
  .pathParam('coll', joi.string(), 'The collection to remove the index for')
  .pathParam('key', joi.string(), 'The unique identifier of the index without the {collection}/ prefix.');
