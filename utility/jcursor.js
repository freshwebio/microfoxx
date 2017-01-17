'use strict';

// Define an object prototype for our own cursor objects retrieved from the cursor collection.
function JCursor(cursorData) {

  // Simply take a copy of the provided cursor data
  // to maintain the current position and the result set.
  this.cursorData = Object.assign({}, cursorData);

  /**
   * Retrieves the next item in the case there is another item available
   * that hasn't already been consumed in the cursor.
   * In the case there are no more items left to consume return null.
   *
   * @returns {*}
   */
  this.next = function() {
    return this.cursorData._documents[this.cursorData._current++] || null;
  };

  /**
   * Tells us whether or not there are more documents in the cursor to be consumed.
   * @returns {boolean}
   */
  this.hasNext = function() {
    return this.cursorData._current < this.cursorData._countTotal;
  };
}

// Now export our JCursor "class" to be used elsewhere in the service.
exports = JCursor;
