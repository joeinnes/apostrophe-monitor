const chokidar = require('chokidar');
const clear = require('clear-require');
const fs = require('fs');
const path = require('path');
const anymatch = require('anymatch');
const quote = require('regexp-quote');
const http = require('http');
const stoppable = require('stoppable');

let restartable = false;
let timeout = null;
let error = {
  warned: false,
  message: null,
  stack: null
};

let appDir, entry, from;
try {
  appDir = process.cwd();
  entry = require(appDir + '/package.json').main;
  from = appDir + '/' + entry;
  appDir = path.dirname(from);
} catch (e) {
  if (entry) {
    console.error(e);
    if (!entry.match(/\.\w+$/)) {
      // Intentionally add this late, for
      entry += '.js';
    }
    console.error('Unable to find app.js at ' + entry + '.');
  } else {
    console.error('You need to run this from an Apostrophe site\'s main folder.');
    console.error('Hint: npm install it, locally to that project, and run\n');
    console.error('"npx monitor". (Yes, the "x" is correct.)');
  }
}

appDir = unixSlashes(appDir);
console.log('Watching ' + appDir);

let ignore = [
  '/lib/modules/*/public/**',
  '/node_modules/**',
  '/public/modules/**',
  '/public/uploads/**',
  '/public/css/master-*',
  '/locales/**',
  '/data/temp/**'
];
let config;
if (fs.existsSync(appDir + '/monitor-config.js')) {
  config = require(appDir + '/monitor-config.js');
  ignore = ignore.concat(config.addIgnore || []);
}

ignore = ignore.map(rule => appDir + unixSlashes(rule));

chokidar.watch([appDir], {
  ignored: function (path) {
    // We're seeing paths appear both ways, Unix and non-, on Windows
    // for each call and one always is not ignored. Normalize to Unix
    path = unixSlashes(path);
    // Same module otherwise used by chokidar
    return anymatch(ignore, path);
  }
}).on('all', change);

let apos = null;

const errorHandlingServer = http.createServer(function (req, res) {
  res.writeHead(500, {'Content-Type': 'text/html'});
  res.write(`<body>
  <h1>You have a code error</h1>
    <strong>${error.message}</strong><br />
    <code>
    ${escapeHtml(error.stack).replace('\n', '<br />')}
    </code>
  </body>`);
  res.end();
});

// 0 kills immediately, freeing up the port at the expense of
// active connections. Shouldn't matter, as allowing new clients
// to connect to a working application is higher priority than 
// sending an error message to old clients for something already 
// fixed
stoppable(errorHandlingServer, 0);

function start() {
  try {
    const start = Date.now();
    if (apos && !error.warned) {
      console.error('Restarting in response to changes...');
    }
    apos = require(from);
    // Does this smell like an apos object, or more like the default
    // empty exports object of an app.js that doesn't export anything?
    if ((!apos) || (!apos.synth)) {
      console.error('Your app.js does not export the apos object.');
      youNeed();
      process.exit(1);
    }
    if (!apos.options.root) {
      console.error('You did not pass root to the apos object.');
      youNeed();
      process.exit(1);
    }

    apos.options.afterInit = function (cb) {
      if (errorHandlingServer.listening) {
        errorHandlingServer.stop((err) => {
          if (err) {
            console.error('Could not stop error handling server.');
            process.exit(1);
          }
          cb();
        })
      } else {
        cb();
      }
    }

    apos.options.afterListen = function (err) {
      if (err) {
        console.error(err);
      }
      const end = Date.now();
      if (apos.argv['profile-monitor']) {
        console.log('Startup time: ' + (end - start) + 'ms');
      }
      console.error('Waiting for changes...');
      restartable = true;
      error = {
        message: null,
        stack: null,
        warned: null
      };
    };
  } catch (e) {
    // If it's a new error, fire up our error handling server
    // and log the error details
    if (!error.warned) {
      errorHandlingServer.listen(process.env.PORT || 3000)
      console.error('An error occurred when restarting: ', e.message, e.stack);
      error = {
        message: e.message,
        stack: e.stack,
        warned: true
      }
    }
    if (!timeout) {
      timeout = setTimeout(function () {
        timeout = null;
        return start();
      }, 100);
    }
  }
}

function change(event, filename) {
  if (!filename) {
    return;
  }
  if (filename === module.filename) {
    // monitor.js can't monitor itself, nor will it change in normal use anyway
    return;
  }
  clear(filename);
  // otherwise we keep getting the same apos object back
  clear(from);
  if (!restartable) {
    if (!timeout) {
      timeout = setTimeout(function () {
        timeout = null;
        return change(filename);
      }, 100);
    }
    return;
  }
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  restart();
}

function restart() {
  restartable = false;
  return apos.destroy(function (err) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    start();
  });
}

start();

function unixSlashes(s) {
  return s.replace(new RegExp(quote(path.sep), 'g'), '/');
}

function youNeed() {
  console.error('\nYou need:\n');
  console.error('module.exports = require(\'apostrophe\') {');
  console.error('  root: module');
  console.error('  // the rest of your configuration follows as usual');
  console.error('};');
}

// https://stackoverflow.com/questions/1787322/htmlspecialchars-equivalent-in-javascript
function escapeHtml(text) {
  return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
}
