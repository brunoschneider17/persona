/**
 * Uncompressed source can be found at https://browserid.org/include.orig.js
 *
 * ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla BrowserID.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

(function() {
  // this is the file that the RP includes to shim in the
  // navigator.id.getVerifiedEmail() function
//  "use strict";

  // local embedded copy of jschannel: http://github.com/mozilla/jschannel
  /**
   * js_channel is a very lightweight abstraction on top of
   * postMessage which defines message formats and semantics
   * to support interactions more rich than just message passing
   * js_channel supports:
   *  + query/response - traditional rpc
   *  + query/update/response - incremental async return of results
   *    to a query
   *  + notifications - fire and forget
   *  + error handling
   *
   * js_channel is based heavily on json-rpc, but is focused at the
   * problem of inter-iframe RPC.
   *
   * Message types:
   *  There are 5 types of messages that can flow over this channel,
   *  and you may determine what type of message an object is by
   *  examining its parameters:
   *  1. Requests
   *    + integer id
   *    + string method
   *    + (optional) any params
   *  2. Callback Invocations (or just "Callbacks")
   *    + integer id
   *    + string callback
   *    + (optional) params
   *  3. Error Responses (or just "Errors)
   *    + integer id
   *    + string error
   *    + (optional) string message
   *  4. Responses
   *    + integer id
   *    + (optional) any result
   *  5. Notifications
   *    + string method
   *    + (optional) any params
   */
   var Channel = (function() {
    "use strict";

    // current transaction id, start out at a random *odd* number between 1 and a million
    // There is one current transaction counter id per page, and it's shared between
    // channel instances.  That means of all messages posted from a single javascript
    // evaluation context, we'll never have two with the same id.
    var s_curTranId = Math.floor(Math.random()*1000001);

    // no two bound channels in the same javascript evaluation context may have the same origin, scope, and window.
    // futher if two bound channels have the same window and scope, they may not have *overlapping* origins
    // (either one or both support '*').  This restriction allows a single onMessage handler to efficiently
    // route messages based on origin and scope.  The s_boundChans maps origins to scopes, to message
    // handlers.  Request and Notification messages are routed using this table.
    // Finally, channels are inserted into this table when built, and removed when destroyed.
    var s_boundChans = { };

    // add a channel to s_boundChans, throwing if a dup exists
    function s_addBoundChan(win, origin, scope, handler) {
      function hasWin(arr) {
        for (var i = 0; i < arr.length; i++) if (arr[i].win === win) return true;
        return false;
      }

      // does she exist?
      var exists = false;


      if (origin === '*') {
        // we must check all other origins, sadly.
        for (var k in s_boundChans) {
          if (!s_boundChans.hasOwnProperty(k)) continue;
          if (k === '*') continue;
          if (typeof s_boundChans[k][scope] === 'object') {
            exists = hasWin(s_boundChans[k][scope]);
            if (exists) break;
          }
        }
      } else {
        // we must check only '*'
        if ((s_boundChans['*'] && s_boundChans['*'][scope])) {
          exists = hasWin(s_boundChans['*'][scope]);
        }
        if (!exists && s_boundChans[origin] && s_boundChans[origin][scope])
        {
          exists = hasWin(s_boundChans[origin][scope]);
        }
      }
      if (exists) throw "A channel is already bound to the same window which overlaps with origin '"+ origin +"' and has scope '"+scope+"'";

      if (typeof s_boundChans[origin] != 'object') s_boundChans[origin] = { };
      if (typeof s_boundChans[origin][scope] != 'object') s_boundChans[origin][scope] = [ ];
      s_boundChans[origin][scope].push({win: win, handler: handler});
    }

    function s_removeBoundChan(win, origin, scope) {
      var arr = s_boundChans[origin][scope];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].win === win) {
          arr.splice(i,1);
        }
      }
      if (s_boundChans[origin][scope].length === 0) {
        delete s_boundChans[origin][scope]
      }
    }

    function s_isArray(obj) {
      if (Array.isArray) return Array.isArray(obj);
      else {
        return (obj.constructor.toString().indexOf("Array") != -1);
      }
    }

    // No two outstanding outbound messages may have the same id, period.  Given that, a single table
    // mapping "transaction ids" to message handlers, allows efficient routing of Callback, Error, and
    // Response messages.  Entries are added to this table when requests are sent, and removed when
    // responses are received.
    var s_transIds = { };

    // class singleton onMessage handler
    // this function is registered once and all incoming messages route through here.  This
    // arrangement allows certain efficiencies, message data is only parsed once and dispatch
    // is more efficient, especially for large numbers of simultaneous channels.
    var s_onMessage = function(e) {
      try {
        var m = JSON.parse(e.data);
        if (typeof m !== 'object' || m === null) throw "malformed";
      } catch(e) {
        // just ignore any posted messages that do not consist of valid JSON
        return;
      }

      var w = e.source;
      var o = e.origin;
      var s, i, meth;

      if (typeof m.method === 'string') {
        var ar = m.method.split('::');
        if (ar.length == 2) {
          s = ar[0];
          meth = ar[1];
        } else {
          meth = m.method;
        }
      }

      if (typeof m.id !== 'undefined') i = m.id;

      // w is message source window
      // o is message origin
      // m is parsed message
      // s is message scope
      // i is message id (or undefined)
      // meth is unscoped method name
      // ^^ based on these factors we can route the message

      // if it has a method it's either a notification or a request,
      // route using s_boundChans
      if (typeof meth === 'string') {
        var delivered = false;
        if (s_boundChans[o] && s_boundChans[o][s]) {
          for (var i = 0; i < s_boundChans[o][s].length; i++) {
            if (s_boundChans[o][s][i].win === w) {
              s_boundChans[o][s][i].handler(o, meth, m);
              delivered = true;
              break;
            }
          }
        }

        if (!delivered && s_boundChans['*'] && s_boundChans['*'][s]) {
          for (var i = 0; i < s_boundChans['*'][s].length; i++) {
            if (s_boundChans['*'][s][i].win === w) {
              s_boundChans['*'][s][i].handler(o, meth, m);
              break;
            }
          }
        }
      }
      // otherwise it must have an id (or be poorly formed
      else if (typeof i != 'undefined') {
        if (s_transIds[i]) s_transIds[i](o, meth, m);
      }
    };

    // Setup postMessage event listeners
    if (window.addEventListener) window.addEventListener('message', s_onMessage, false);
    else if(window.attachEvent) window.attachEvent('onmessage', s_onMessage);

    /* a messaging channel is constructed from a window and an origin.
     * the channel will assert that all messages received over the
     * channel match the origin
     *
     * Arguments to Channel.build(cfg):
     *
     *   cfg.window - the remote window with which we'll communicate
     *   cfg.origin - the expected origin of the remote window, may be '*'
     *                which matches any origin
     *   cfg.scope  - the 'scope' of messages.  a scope string that is
     *                prepended to message names.  local and remote endpoints
     *                of a single channel must agree upon scope. Scope may
     *                not contain double colons ('::').
     *   cfg.debugOutput - A boolean value.  If true and window.console.log is
     *                a function, then debug strings will be emitted to that
     *                function.
     *   cfg.debugOutput - A boolean value.  If true and window.console.log is
     *                a function, then debug strings will be emitted to that
     *                function.
     *   cfg.postMessageObserver - A function that will be passed two arguments,
     *                an origin and a message.  It will be passed these immediately
     *                before messages are posted.
     *   cfg.gotMessageObserver - A function that will be passed two arguments,
     *                an origin and a message.  It will be passed these arguments
     *                immediately after they pass scope and origin checks, but before
     *                they are processed.
     *   cfg.onReady - A function that will be invoked when a channel becomes "ready",
     *                this occurs once both sides of the channel have been
     *                instantiated and an application level handshake is exchanged.
     *                the onReady function will be passed a single argument which is
     *                the channel object that was returned from build().
     */
    return {
      build: function(cfg) {
        var debug = function(m) {
          if (cfg.debugOutput && window.console && window.console.log) {
            // try to stringify, if it doesn't work we'll let javascript's built in toString do its magic
            try { if (typeof m !== 'string') m = JSON.stringify(m); } catch(e) { }
            console.log("["+chanId+"] " + m);
          }
        }

        /* browser capabilities check */
        if (!window.postMessage) throw("jschannel cannot run this browser, no postMessage");
        if (!window.JSON || !window.JSON.stringify || ! window.JSON.parse) {
          throw("jschannel cannot run this browser, no JSON parsing/serialization");
        }

        /* basic argument validation */
        if (typeof cfg != 'object') throw("Channel build invoked without a proper object argument");

        if (!cfg.window || !cfg.window.postMessage) throw("Channel.build() called without a valid window argument");

        /* we'd have to do a little more work to be able to run multiple channels that intercommunicate the same
         * window...  Not sure if we care to support that */
        if (window === cfg.window) throw("target window is same as present window -- not allowed");

        // let's require that the client specify an origin.  if we just assume '*' we'll be
        // propagating unsafe practices.  that would be lame.
        var validOrigin = false;
        if (typeof cfg.origin === 'string') {
          var oMatch;
          if (cfg.origin === "*") validOrigin = true;
          // allow valid domains under http and https.  Also, trim paths off otherwise valid origins.
          else if (null !== (oMatch = cfg.origin.match(/^https?:\/\/(?:[-a-zA-Z0-9\.])+(?::\d+)?/))) {
            cfg.origin = oMatch[0].toLowerCase();
            validOrigin = true;
          }
        }

        if (!validOrigin) throw ("Channel.build() called with an invalid origin");

        if (typeof cfg.scope !== 'undefined') {
          if (typeof cfg.scope !== 'string') throw 'scope, when specified, must be a string';
          if (cfg.scope.split('::').length > 1) throw "scope may not contain double colons: '::'"
        }

        /* private variables */
        // generate a random and psuedo unique id for this channel
        var chanId = (function () {
          var text = "";
          var alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
          for(var i=0; i < 5; i++) text += alpha.charAt(Math.floor(Math.random() * alpha.length));
          return text;
        })();

        // registrations: mapping method names to call objects
        var regTbl = { };
        // current oustanding sent requests
        var outTbl = { };
        // current oustanding received requests
        var inTbl = { };
        // are we ready yet?  when false we will block outbound messages.
        var ready = false;
        var pendingQueue = [ ];

        var createTransaction = function(id,origin,callbacks) {
          var shouldDelayReturn = false;
          var completed = false;

          return {
            origin: origin,
            invoke: function(cbName, v) {
              // verify in table
              if (!inTbl[id]) throw "attempting to invoke a callback of a nonexistent transaction: " + id;
              // verify that the callback name is valid
              var valid = false;
              for (var i = 0; i < callbacks.length; i++) if (cbName === callbacks[i]) { valid = true; break; }
              if (!valid) throw "request supports no such callback '" + cbName + "'";

              // send callback invocation
              postMessage({ id: id, callback: cbName, params: v});
            },
            error: function(error, message) {
              completed = true;
              // verify in table
              if (!inTbl[id]) throw "error called for nonexistent message: " + id;

              // remove transaction from table
              delete inTbl[id];

              // send error
              postMessage({ id: id, error: error, message: message });
            },
            complete: function(v) {
              completed = true;
              // verify in table
              if (!inTbl[id]) throw "complete called for nonexistent message: " + id;
              // remove transaction from table
              delete inTbl[id];
              // send complete
              postMessage({ id: id, result: v });
            },
            delayReturn: function(delay) {
              if (typeof delay === 'boolean') {
                shouldDelayReturn = (delay === true);
              }
              return shouldDelayReturn;
            },
            completed: function() {
              return completed;
            }
          };
        }

        var setTransactionTimeout = function(transId, timeout, method) {
          return window.setTimeout(function() {
            if (outTbl[transId]) {
              // XXX: what if client code raises an exception here?
              var msg = "timeout (" + timeout + "ms) exceeded on method '" + method + "'";
              (1,outTbl[transId].error)("timeout_error", msg);
              delete outTbl[transId];
              delete s_transIds[transId];
            }
          }, timeout);
        }

        var onMessage = function(origin, method, m) {
          // if an observer was specified at allocation time, invoke it
          if (typeof cfg.gotMessageObserver === 'function') {
            // pass observer a clone of the object so that our
            // manipulations are not visible (i.e. method unscoping).
            // This is not particularly efficient, but then we expect
            // that message observers are primarily for debugging anyway.
            try {
              cfg.gotMessageObserver(origin, m);
            } catch (e) {
              debug("gotMessageObserver() raised an exception: " + e.toString());
            }
          }

          // now, what type of message is this?
          if (m.id && method) {
            // a request!  do we have a registered handler for this request?
            if (regTbl[method]) {
              var trans = createTransaction(m.id, origin, m.callbacks ? m.callbacks : [ ]);
              inTbl[m.id] = { };
              try {
                // callback handling.  we'll magically create functions inside the parameter list for each
                // callback
                if (m.callbacks && s_isArray(m.callbacks) && m.callbacks.length > 0) {
                  for (var i = 0; i < m.callbacks.length; i++) {
                    var path = m.callbacks[i];
                    var obj = m.params;
                    var pathItems = path.split('/');
                    for (var j = 0; j < pathItems.length - 1; j++) {
                      var cp = pathItems[j];
                      if (typeof obj[cp] !== 'object') obj[cp] = { };
                      obj = obj[cp];
                    }
                    obj[pathItems[pathItems.length - 1]] = (function() {
                      var cbName = path;
                      return function(params) {
                        return trans.invoke(cbName, params);
                      }
                    })();
                  }
                }
                var resp = regTbl[method](trans, m.params);
                if (!trans.delayReturn() && !trans.completed()) trans.complete(resp);
              } catch(e) {
                // automagic handling of exceptions:
                var error = "runtime_error";
                var message = null;
                // * if it's a string then it gets an error code of 'runtime_error' and string is the message
                if (typeof e === 'string') {
                  message = e;
                } else if (typeof e === 'object') {
                  // either an array or an object
                  // * if it's an array of length two, then  array[0] is the code, array[1] is the error message
                  if (e && s_isArray(e) && e.length == 2) {
                    error = e[0];
                    message = e[1];
                  }
                  // * if it's an object then we'll look form error and message parameters
                  else if (typeof e.error === 'string') {
                    error = e.error;
                    if (!e.message) message = "";
                    else if (typeof e.message === 'string') message = e.message;
                    else e = e.message; // let the stringify/toString message give us a reasonable verbose error string
                  }
                }

                // message is *still* null, let's try harder
                if (message === null) {
                  try {
                    message = JSON.stringify(e);
                    /* On MSIE8, this can result in 'out of memory', which
                     * leaves message undefined. */
                    if (typeof(message) == 'undefined')
                      message = e.toString();
                  } catch (e2) {
                    message = e.toString();
                  }
                }

                trans.error(error,message);
              }
            }
          } else if (m.id && m.callback) {
            if (!outTbl[m.id] ||!outTbl[m.id].callbacks || !outTbl[m.id].callbacks[m.callback])
            {
              debug("ignoring invalid callback, id:"+m.id+ " (" + m.callback +")");
            } else {
              // XXX: what if client code raises an exception here?
              outTbl[m.id].callbacks[m.callback](m.params);
            }
          } else if (m.id) {
            if (!outTbl[m.id]) {
              debug("ignoring invalid response: " + m.id);
            } else {
              // XXX: what if client code raises an exception here?
              if (m.error) {
                (1,outTbl[m.id].error)(m.error, m.message);
              } else {
                if (m.result !== undefined) (1,outTbl[m.id].success)(m.result);
                else (1,outTbl[m.id].success)();
              }
              delete outTbl[m.id];
              delete s_transIds[m.id];
            }
          } else if (method) {
            // tis a notification.
            if (regTbl[method]) {
              // yep, there's a handler for that.
              // transaction is null for notifications.
              regTbl[method](null, m.params);
              // if the client throws, we'll just let it bubble out
              // what can we do?  Also, here we'll ignore return values
            }
          }
        }

        // now register our bound channel for msg routing
        s_addBoundChan(cfg.window, cfg.origin, ((typeof cfg.scope === 'string') ? cfg.scope : ''), onMessage);

        // scope method names based on cfg.scope specified when the Channel was instantiated
        var scopeMethod = function(m) {
          if (typeof cfg.scope === 'string' && cfg.scope.length) m = [cfg.scope, m].join("::");
          return m;
        }

        // a small wrapper around postmessage whose primary function is to handle the
        // case that clients start sending messages before the other end is "ready"
        var postMessage = function(msg, force) {
          if (!msg) throw "postMessage called with null message";

          // delay posting if we're not ready yet.
          var verb = (ready ? "post  " : "queue ");
          debug(verb + " message: " + JSON.stringify(msg));
          if (!force && !ready) {
            pendingQueue.push(msg);
          } else {
            if (typeof cfg.postMessageObserver === 'function') {
              try {
                cfg.postMessageObserver(cfg.origin, msg);
              } catch (e) {
                debug("postMessageObserver() raised an exception: " + e.toString());
              }
            }

            cfg.window.postMessage(JSON.stringify(msg), cfg.origin);
          }
        }

        var onReady = function(trans, type) {
          debug('ready msg received');
          if (ready) throw "received ready message while in ready state.  help!";

          if (type === 'ping') {
            chanId += '-R';
          } else {
            chanId += '-L';
          }

          obj.unbind('__ready'); // now this handler isn't needed any more.
          ready = true;
          debug('ready msg accepted.');

          if (type === 'ping') {
            obj.notify({ method: '__ready', params: 'pong' });
          }

          // flush queue
          while (pendingQueue.length) {
            postMessage(pendingQueue.pop());
          }

          // invoke onReady observer if provided
          if (typeof cfg.onReady === 'function') cfg.onReady(obj);
        };

        var obj = {
          // tries to unbind a bound message handler.  returns false if not possible
          unbind: function (method) {
            if (regTbl[method]) {
              if (!(delete regTbl[method])) throw ("can't delete method: " + method);
              return true;
            }
            return false;
          },
          bind: function (method, cb) {
            if (!method || typeof method !== 'string') throw "'method' argument to bind must be string";
            if (!cb || typeof cb !== 'function') throw "callback missing from bind params";

            if (regTbl[method]) throw "method '"+method+"' is already bound!";
            regTbl[method] = cb;
            return this;
          },
          call: function(m) {
            if (!m) throw 'missing arguments to call function';
            if (!m.method || typeof m.method !== 'string') throw "'method' argument to call must be string";
            if (!m.success || typeof m.success !== 'function') throw "'success' callback missing from call";

            // now it's time to support the 'callback' feature of jschannel.  We'll traverse the argument
            // object and pick out all of the functions that were passed as arguments.
            var callbacks = { };
            var callbackNames = [ ];

            var pruneFunctions = function (path, obj) {
              if (typeof obj === 'object') {
                for (var k in obj) {
                  if (!obj.hasOwnProperty(k)) continue;
                  var np = path + (path.length ? '/' : '') + k;
                  if (typeof obj[k] === 'function') {
                    callbacks[np] = obj[k];
                    callbackNames.push(np);
                    delete obj[k];
                  } else if (typeof obj[k] === 'object') {
                    pruneFunctions(np, obj[k]);
                  }
                }
              }
            };
            pruneFunctions("", m.params);

            // build a 'request' message and send it
            var msg = { id: s_curTranId, method: scopeMethod(m.method), params: m.params };
            if (callbackNames.length) msg.callbacks = callbackNames;

            if (m.timeout)
              // XXX: This function returns a timeout ID, but we don't do anything with it.
              // We might want to keep track of it so we can cancel it using clearTimeout()
              // when the transaction completes.
              setTransactionTimeout(s_curTranId, m.timeout, scopeMethod(m.method));

            // insert into the transaction table
            outTbl[s_curTranId] = { callbacks: callbacks, error: m.error, success: m.success };
            s_transIds[s_curTranId] = onMessage;

            // increment current id
            s_curTranId++;

            postMessage(msg);
          },
          notify: function(m) {
            if (!m) throw 'missing arguments to notify function';
            if (!m.method || typeof m.method !== 'string') throw "'method' argument to notify must be string";

            // no need to go into any transaction table
            postMessage({ method: scopeMethod(m.method), params: m.params });
          },
          destroy: function () {
            s_removeBoundChan(cfg.window, cfg.origin, ((typeof cfg.scope === 'string') ? cfg.scope : ''));
            if (window.removeEventListener) window.removeEventListener('message', onMessage, false);
            else if(window.detachEvent) window.detachEvent('onmessage', onMessage);
            ready = false;
            regTbl = { };
            inTbl = { };
            outTbl = { };
            cfg.origin = null;
            pendingQueue = [ ];
            debug("channel destroyed");
            chanId = "";
          }
        };

        obj.bind('__ready', onReady);
        setTimeout(function() {
//          postMessage({ method: scopeMethod('__ready'), params: "ping" }, true);
        }, 0);

        return obj;
      }
    };
  })();

  // local embedded copy of winchan: http://github.com/lloyd/winchan
  ;WinChan = (function() {
    var IFRAME_NAME = "_moz_vep_comm_iframe";

    // a portable addListener implementation
    function addListener(w, event, cb) {
      if(w.attachEvent) w.attachEvent('on' + event, cb);
      else if (w.addEventListener) w.addEventListener(event, cb, false);
    }

    // a portable removeListener implementation
    function removeListener(w, event, cb) {
      if(w.detachEvent) w.detachEvent('on' + event, cb);
      else if (w.removeEventListener) w.removeEventListener(event, cb, false);
    }

    // checking for IE8 or above
    function isInternetExplorer() {
      var rv = -1; // Return value assumes failure.
      if (navigator.appName == 'Microsoft Internet Explorer') {
        var ua = navigator.userAgent;
        var re = new RegExp("MSIE ([0-9]{1,}[\.0-9]{0,})");
        if (re.exec(ua) != null)
          rv = parseFloat(RegExp.$1);
      }
      return rv >= 8;
    }

    // checking Mobile Firefox (Fennec)
    function isFennec() {
      try {
        return (navigator.userAgent.indexOf('Fennec/') != -1);
      } catch(e) {};
      return false;
    }

    // feature checking to see if this platform is supported at all
    function isSupported() {
      return (window.JSON && window.JSON.stringify &&
              window.JSON.parse && window.postMessage);
    }

    // given a URL, extract the origin
    function extractOrigin(url) {
      var m = /^(https?:\/\/[-_a-zA-Z\.0-9:]+)/.exec(url);
      if (m) return m[1];
      return url;
    }

    if (isInternetExplorer()) {
      // find the relay iframe in the opener
      function findRelay() {
        var loc = window.location;
        var frames = window.opener.frames;
        var origin = loc.protocol + '//' + loc.host;
        for (i = frames.length - 1; i >= 0; i++) {
          try {
            if (frames[i].location.href.indexOf(origin) === 0 &&
                frames[i].name === IFRAME_NAME)
            {
              return frames[i];
            }
          } catch(e) { }
        }
        return;
      }

      /*  This is how we roll on IE:
       *  0. user clicks
       *  1. caller adds relay iframe (served from trusted domain) to DOM
       *  2. caller opens window (with content from trusted domain)
       *  3. window on opening adds a listener to 'message'
       *  4. window on opening finds iframe
       *  5. window checks if iframe is "loaded" - has a 'doPost' function yet
       *  5a. if iframe.doPost exists, window uses it to send ready event to caller
       *  5b. if iframe.doPost doesn't exist, window waits for frame ready
       *   5bi. once ready, window calls iframe.doPost to send ready event
       *  6. caller upon reciept of 'ready', sends args
       */
      return {
        open: function(url, relay_url, winopts, arg, cb) {
          if (!cb) throw "missing required callback argument";

          // sanity check, are url and relay_url the same origin? 
          var origin = extractOrigin(url);
          if (origin !== extractOrigin(relay_url)) {
            setTimeout(function() {
              cb('invalid arguments: origin of url and relay_url must match');
            })
            return;
          }

          // first we need to add a "relay" iframe to the document that's served
          // from the target domain.  We can postmessage into a iframe, but not a
          // window
          var iframe = document.createElement("iframe");
          // iframe.setAttribute('name', framename);
          iframe.setAttribute('src', relay_url);
          iframe.style.display = "none";
          iframe.setAttribute('name', IFRAME_NAME);
          document.body.appendChild(iframe);

          var w = window.open(url, null, winopts); 
          var req = JSON.stringify({a: 'request', d: arg});

          // cleanup on unload
          function cleanup() {
            document.body.removeChild(iframe);
            if (w) w.close();
            w = undefined;
          }

          addListener(window, 'unload', cleanup);

          function onMessage(e) {
            try {
              var d = JSON.parse(e.data);
              if (d.a === 'ready') iframe.contentWindow.postMessage(req, origin);
              else if (d.a === 'error') cb(d.d);
              else if (d.a === 'response') {
                removeListener(window, 'message', onMessage);
                removeListener(window, 'unload', cleanup);
                cleanup();
                cb(null, d.d);
              }
            } catch(e) { }
          };

          addListener(window, 'message', onMessage);

          return {
            close: function() {
              if (w) w.close();
              w = undefined;
            },
            focus: function() {
              if (w) w.focus();
            }
          };
        },
        onOpen: function(cb) {
          var o = "*";
          var theFrame = findRelay();
          if (!theFrame) throw "can't find relay frame";

          function onMessage(e) {
            var d;
            o = e.origin;
            try {
              d = JSON.parse(e.data);
            } catch(e) { }
            if (cb) cb(o, d.d, function(r) {
              cb = undefined;
              theFrame.doPost(JSON.stringify({a: 'response', d: r}), o);
            });
          }
          addListener(theFrame, 'message', onMessage);

          // we cannot post to our parent that we're ready before the iframe
          // is loaded.
          try {
            theFrame.doPost('{"a": "ready"}', o);
          } catch(e) {
            addListener(theFrame, 'load', function(e) {
              theFrame.doPost('{"a": "ready"}', o);
            });
          }

          // if window is unloaded and the client hasn't called cb, it's an error
          addListener(window, 'unload', function() {
            if (cb) theFrame.doPost(JSON.stringify({
              a: 'error', d: 'client closed window'
            }), o);
            cb = undefined;
            // explicitly close the window, in case the client is trying to reload or nav
            try { window.close(); } catch (e) { };
          });
        }
      };
    } else if (isSupported()) {
      return {
        open: function(url, relay_url, winopts, arg, cb) {
          if (!cb) throw "missing required callback argument";

          // sanity check, are url and relay_url the same origin? 
          var origin = extractOrigin(url);
          if (origin !== extractOrigin(relay_url)) {
            setTimeout(function() {
              cb('invalid arguments: origin of url and relay_url must match');
            })
            return;
          }

          var w = window.open(url, null, isFennec() ? undefined : winopts);
          var req = JSON.stringify({a: 'request', d: arg});

          // cleanup on unload
          function cleanup() {
            if (w) w.close();
            w = undefined;
          }
          addListener(window, 'unload', cleanup);

          function onMessage(e) {
            try {
              var d = JSON.parse(e.data);
              if (d.a === 'ready') w.postMessage(req, origin);
              else if (d.a === 'error') cb(d.d);
              else if (d.a === 'response') {
                removeListener(window, 'message', onMessage);
                removeListener(window, 'unload', cleanup);
                cleanup();
                cb(null, d.d);
              }
            } catch(e) { }
          }
          addListener(window, 'message', onMessage);

          return {
            close: function() {
              if (w) w.close();
              w = undefined;
            },
            focus: function() {
              if (w) w.focus();
            }
          };
        },
        onOpen: function(cb) {
          var o = "*";
          var parentWin = window.opener;
          function onMessage(e) {
            var d;
            o = e.origin;
            try {
              d = JSON.parse(e.data);
            } catch(e) {
              // ignore
            }
            cb(o, d.d, function(r) {
              cb = undefined;
              parentWin.postMessage(JSON.stringify({a: 'response', d: r}), o);
            });
          }
          addListener(window, 'message', onMessage);
          parentWin.postMessage('{"a": "ready"}', o);

          // if window is unloaded and the client hasn't called cb, it's an error
          addListener(window, 'unload', function() {
            if (cb) parentWin.postMessage(JSON.stringify({
              a: 'error',
              d: 'client closed window'
            }), o);
            cb = undefined;
            // explicitly close the window, in case the client is trying to reload or nav
            try { window.close(); } catch (e) { };
          });
        }
      };
    } else {
      return {
        open: function(url, winopts, arg, cb) {
          setTimeout(function() { cb("unsupported browser"); }, 0);
        },
        onOpen: function(cb) {
          setTimeout(function() { cb("unsupported browser"); }, 0);
        }
      };
    }
  })();


  var BrowserSupport = (function() {
    var win = window,
        nav = navigator,
        reason;

    // For unit testing
    function setTestEnv(newNav, newWindow) {
      nav = newNav;
      win = newWindow;
    }

    function getInternetExplorerVersion() {
      var rv = -1; // Return value assumes failure.
      if (nav.appName == 'Microsoft Internet Explorer') {
        var ua = nav.userAgent;
        var re = new RegExp("MSIE ([0-9]{1,}[\.0-9]{0,})");
        if (re.exec(ua) != null)
          rv = parseFloat(RegExp.$1);
      }

      return rv;
    }

    function checkIE() {
      var ieVersion = getInternetExplorerVersion(),
          ieNosupport = ieVersion > -1 && ieVersion < 8;

      if(ieNosupport) {
        return "IE_VERSION";
      }
    }

    function explicitNosupport() {
      return checkIE();
    }

    function checkLocalStorage() {
      var localStorage = 'localStorage' in win && win['localStorage'] !== null;
      if(!localStorage) {
        return "LOCALSTORAGE";
      }
    }

    function checkPostMessage() {
      if(!win.postMessage) {
        return "POSTMESSAGE";
      }
    }

    function isSupported() {
      reason = checkLocalStorage() || checkPostMessage() || explicitNosupport();

      return !reason;
    }

    function getNoSupportReason() {
      return reason;
    }

    return {
      /**
       * Set the test environment.
       * @method setTestEnv
       */
      setTestEnv: setTestEnv,
      /**
       * Check whether the current browser is supported
       * @method isSupported
       * @returns {boolean}
       */
      isSupported: isSupported,
      /**
       * Called after isSupported, if isSupported returns false.  Gets the reason
       * why browser is not supported.
       * @method getNoSupportReason
       * @returns {string}
       */
      getNoSupportReason: getNoSupportReason
    };
  }());


  // this is for calls that are non-interactive
  function _open_hidden_iframe(doc) {
    var iframe = doc.createElement("iframe");
    iframe.style.display = "none";
    doc.body.appendChild(iframe);
    iframe.src = ipServer + "/communication_iframe";
    return iframe;
  }

  /**
   * The meat and potatoes of the verified email protocol
   */


  if (!navigator.id) {
    navigator.id = {};
  }

  if (!navigator.id.getVerifiedEmail || navigator.id._getVerifiedEmailIsShimmed) {
    var ipServer = "https://browserid.org";
    var isFennec = navigator.userAgent.indexOf('Fennec/') != -1;
    var windowOpenOpts =
      (isFennec ? undefined :
       "menubar=0,location=0,resizable=0,scrollbars=0,status=0,dialog=1,width=700,height=375");

    var w;

    navigator.id.get = function(callback, options) {
      if (typeof callback !== 'function') {
        throw "navigator.id.get() requires a callback argument";
      }

      if (options && options.silent) {
        _noninteractiveCall('getPersistentAssertion', { }, function(rv) {
          callback(rv);
        }, function(e, msg) {
          callback(null);
        });
      } else {
        // focus an existing window
        if (w) {
          w.focus();
          return;
        }

        if (!BrowserSupport.isSupported()) {
          w = window.open(
            ipServer + "/unsupported_dialog",
            null,
            windowOpenOpts);
          return;
        }

        w = WinChan.open(
          ipServer + '/sign_in',
          ipServer + '/relay',
          windowOpenOpts,
          {
            method: "get",
            params: options
          },
          function(err, r) {
            // clear the window handle
            w = undefined;
            // ignore err!
            callback(err ? null : (r ? r : null));
          }
        );
      }
    };

    navigator.id.getVerifiedEmail = function (callback, options) {
      if (options) {
        throw "getVerifiedEmail doesn't accept options.  use navigator.id.get() instead.";
      }
      navigator.id.get(callback);
    };

    navigator.id.logout = function(callback) {
      _noninteractiveCall('logout', { }, function(rv) {
        callback(rv);
      }, function() {
        callback(null);
      });
    };

    var _noninteractiveCall = function(method, args, onsuccess, onerror) {
      var doc = window.document;
      var ni_iframe = _open_hidden_iframe(doc);

      var chan = Channel.build({window: ni_iframe.contentWindow, origin: ipServer, scope: "mozid_ni"});

      function cleanup() {
        chan.destroy();
        chan = undefined;
        doc.body.removeChild(ni_iframe);
      }

      chan.call({
        method: method,
        params: args,
        success: function(rv) {
          if (onsuccess) {
            onsuccess(rv);
          }
          cleanup();
        },
        error: function(code, msg) {
          if (onerror) onerror(code, msg);
          cleanup();
        }
      });
    };

    navigator.id._getVerifiedEmailIsShimmed = true;
  }
}());
