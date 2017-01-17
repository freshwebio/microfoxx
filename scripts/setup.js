'use strict';

const env = require('process').env;
const db = require('@arangodb').db;
const createAuth = require('@arangodb/foxx/auth');
const sessions = module.context.collectionName('dbsession');
const users = module.context.collectionName('dbuser');
const events = module.context.collectionName('dbevent');
const cursors = module.context.collectionName('dbcursor');
const queues = require('@arangodb/foxx/queues');
const auth = createAuth();

// Create the session collection if it doesn't already exist.
if (!db._collection(sessions)) {
  db._createDocumentCollection(sessions);
}

if (!db._collection(users)) {
  db._createDocumentCollection(users);
}

// Create the event collection if it doesn't already exist.
if (!db._collection(events)) {
  db._createDocumentCollection(events);
}

if (!db._collection(cursors)) {
  db._createDocumentCollection(cursors);
}

db._collection(users).ensureIndex({
  type: 'hash',
  fields: ['username'],
  unique: true
});

// First of all ensure our user doesn't already exist.
if (db._collection(users).firstExample({username: env.MF_DB_USERNAME}) === null) {
  // Create our single user for the service from the environment variables.
  const user = {
    username: env.MF_DB_USERNAME,
    password: env.MF_DB_PASSWORD
  };

  // Create an authentication hash for the user.
  user.authData = auth.create(user.password);
  delete user.password;

  // Now save our single user for the database service.
  db._collection(users).save(user);
}

// Setup a single queue job that deals with cleaning up cursors
// that are more than 30 seconds old. This is important as cursors
// store result sets allowing remote clients to retrieve documents in batches.
// If a cursor isn't fully utilised for whatever reason
// (Once cursor iteration is complete it gets removed in the endpoint callback)
// we need to make sure we free up storage space as soon as possible as cursors could easily
// fill up the available space.
// Give the queue 3 workers.
var queue = queues.create('microfoxx-queue');
// Create our cursor cleanup job that runs every five seconds to check if there are any cursors that are
// more than 30 seconds old.
queue.push(
  {mount: '/microfoxx', name: 'cleanup-cursors'},
  {},
  {
    repeatTimes: Infinity,
    repeatUntil: Infinity,
    repeatDelay: 10 * 1000
  }
);
