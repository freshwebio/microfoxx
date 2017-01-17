'use strict';

const db = require('@arangodb').db;
const aql = require('@arangodb').aql;
const cursors = module.context.collection('dbcursor');
const thirtySecondsAgo = Date.now() - 30 * 1000;

// First of all retrieve all the cursors that have expired.
const expired = db._query(aql`FOR c IN ${cursors} FILTER c._created < ${thirtySecondsAgo} RETURN c`).toArray();
// Now iterate over each of the expired cursors and remove them from the collection one by one.
for (var i = 0; i < expired.length; i++) {
  cursors.remove(expired[i]);
}
