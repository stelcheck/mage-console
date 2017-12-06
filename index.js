'use strict';

var repl = require('repl');
var net = require('net');
var chalk = require('chalk');
var path = require('path');
var cluster = require('cluster');
var fs = require('fs');
var PrettyError = require('pretty-error');
var watch = require('node-watch');
var MemoryStream = require('memorystream');

var HISTORY_FILE = path.join(process.env.HOME, '.mage-history.json');
var APP_LIB_PATH = path.join(process.cwd(), 'lib');
var APP_CONFIG_PATH = path.join(process.cwd(), 'config');

var debug = require('./debug');
var prettyError = new PrettyError();

/**
 * Additional prefix to set on the REPL's prompt
 */
exports.promptPrefix = '';

/**
 * Debug flag to use
 */
exports.debugFlag = '--debug';

/**
 * Force-configure mage to use cluster: 1 (one master, one process),
 * and set the list of files and folders to watch for.
 */
var config = require('../mage/lib/config');
config.set('server.cluster', 1);

var WATCH_FILES = config.get('external.mage-console.watch', []);

WATCH_FILES.push(APP_CONFIG_PATH);
WATCH_FILES.push(APP_LIB_PATH);

/**
 * Load the application and boot
 */
var mage = require(APP_LIB_PATH);
var logger = mage.core.logger.context('REPL');
var processManager = mage.core.processManager;

mage.boot();

function setRawMode(val) {
	var stdin = process.stdin;

	if (!stdin.setRawMode) {
		logger
			.emergency
			.details('This may happen when using terminals such as MINGW64 on Windows')
			.details('Please try to use PowerShell or cmd.exe instead')
			.log('Cannot run mage-console; cannot switch to raw mode');

		mage.exit(1, true);
	}

	stdin.setRawMode(val);
}

function onceSomeFilesChanged(onChange) {
	var called = false;
	var watcher = watch(WATCH_FILES, {
		recursive: true
	}, function (event, name) {
		if (name.split(path.sep).pop()[0] === '.') {
			return;
		}

		if (called) {
			return;
		}

		called = true;
		watcher.close();
		onChange(event, name);
	});

	return watcher;
}

function crash(error) {
	mage.logger.error(error);
	mage.exit();
}

/**
 * @summary Retrieve the IPC path on which to listen/connect to
 * @returns {String} path the master process will listen on
 */
function getIPCPath() {
	// See https://github.com/nodejs/node/issues/13670 for more details
	const defaultFilepath = path.relative(process.cwd(), path.join(__dirname, 'mage-console.sock'));
	const filepath = config.get('external.mage-console.sockfile') || defaultFilepath;

	if (process.platform === 'win32') {
		return path.join('\\\\.\\pipe', filepath);
	}

	return filepath;
}

var ipcPath = getIPCPath();

function saveHistory(history) {
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

/**
 * @summary Create a REPL server on the worker.
 * @param {net.Socket} client Client connection connecting back to the master process.
 * @param {String} prompt The prompt to set on the REPL instance.
 * @returns {repl.REPLServer} REPL server instance
 */
function createRepl(client, prompt) {
	var instance = repl.start({
		input: client,
		output: client,
		useColors: true,
		terminal: true,
		prompt: prompt
	});

	// We wish to log REPL errors differently than how
	// we log errors coming from MAGE logger, but still
	// in a way that integrates with the logger (so that logs
	// may still be written to file, and so on); we want the logger
	// context, and we want to prettify the error output.
	function logError(error) {
		var newStack = error.stack.split('\n');
		var done = false;
		error.stack = '';

		while (!done && newStack.length > 0) {
			var line = newStack.shift();
			error.stack += line + '\n';
			if (line.indexOf('    at repl:1') !== -1) {
				done = true;
			}
		}

		var rendered = prettyError.render(error);
		rendered = rendered.slice(0, -5);
		rendered = rendered.replace(/\n/g, chalk.styles.red.open + '\n');
		logger.error(rendered);
	}

	// We remove the default domain error handler on the REPL
	// and replace it with our logging factory
	instance._domain.removeAllListeners('error');
	instance._domain.on('error', logError);

	// Finally, we override the eval function.
	// since we want to keep the same behavior as the normal eval
	// but handle errors a bit differently, we create a normal REPL,
	// store it's eval method somewhere, then override it.
	var realEval = instance.eval;
	instance.eval = function (cmd, context, filename, callback) {
		realEval(cmd, context, filename, function (error, res) {
			if (error) {
				if (!error.stack) {
					return callback(error);
				}

				logError(error);
			}

			callback(null, res);
		});
	};

	// Context setup
	instance.context.mage = mage;

	// History load
	try {
		instance.historySize = 500;
		instance.history = require(HISTORY_FILE);
	} catch (error) {
		logger.debug('failed to load history file');
	}

	// On exit, store history and send shutdown signal to master process
	instance.on('exit', function () {
		saveHistory(instance.history);
	});

	return instance;
}

/**
 * Once connected to the master process, we will patch the connection
 * in a newly created REPL server.
 *
 * @summary Connect to the master process
 * @returns {undefined} void
 */
function connect() {
	logger.debug('connecting to master process');

	var closing = false;
	var scheduled = null;

	var client = net.connect(ipcPath, function () {
		// Prompt and REPL configuration
		var prompt = exports.promptPrefix +
				chalk.blue.bold('(' + process.pid + ') ') +
				chalk.cyan('mage/' + mage.rootPackage.name) +
				chalk.magenta(' >> ');

		var promptLength = prompt.length;
		var repl = createRepl(client, prompt);

		repl.on('exit', function () {
			closing = true;
			process.send('shutdown');
		});

		// All MAGE logs are sent on stderr; we capture its output,
		// and proceed to read it line by line
		var stream = new MemoryStream();
		var realStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write =  stream.write.bind(stream);

		var readline = require('readline').createInterface({
			input: stream
		});

		function schedulePrompt() {
			if (closing) {
				return;
			}

			if (scheduled) {
				clearTimeout(scheduled);
			}

			scheduled = setTimeout(function () {
				repl.displayPrompt(true);
			}, 100);
		}

		readline.on('line', function (data) {
			// If we are closing, don't print the prompt
			if (closing) {
				return realStderrWrite(data + '\n');
			}

			// Buffer the current REPL line content
			var lineContent = repl.line;

			// Wipe the printed line - done like this to ensure
			// cross-platform compatibility
			const wipeLine = (new Array(lineContent.length + promptLength + 1)).join(' ');
			realStderrWrite(`\r${wipeLine}\r`);
			realStderrWrite(data + '\n');

			schedulePrompt();
		});

		// Watch the lib folder for changes
		onceSomeFilesChanged(function (event, name) {
			logger.debug('File ' + name + ' was ' + event + 'd, reloading');
			saveHistory(repl.history);
			process.send('reload');
		});
	});

	// Propagate the stdout resize events to the client, so that the readline
	// interface behind our REPL may process properly commands that fit on
	// multiple lines
	client.columns = process.stdout.columns;
	client.rows = process.stdout.rows;

	// Some versions of Node have a bug where 'resize' does not
	// fire up; we directly call on sigwinch as well just to be sure
	//
	// Ref: https://github.com/nodejs/node/issues/16194
	function onResize() {
		client.columns = process.stdout.columns;
		client.rows = process.stdout.rows;
		client.emit('resize');
	}

	process.on('SIGWINCH', onResize);
	process.stdout.on('resize', onResize);

	client.once('end', function () {
		closing = true;
		connect();
	});
}

// Workers connect to the master process
if (cluster.isWorker) {
	// Connect to the master process and provide it
	// with an access to a REPL interface
	return setTimeout(connect, 1000);
}

// Master process provides a network server for process
// to connect to, and patches stdin/stdout/stderr into
// the connection. It also hijacks MAGE's reload logic, so
// to allow for pauses while waiting for a restart (example:
// if the server reloads and crashes, wait for a file change
// before restarting)

processManager.on('started', function () {
	cluster.removeAllListeners('exit');
	cluster.on('exit', function (worker) {
		worker.dropStartupTimeout();

		var id = worker.mageWorkerId;
		processManager.emit('workerOffline', id, worker._mageManagedExit);

		// If a worker was running and it suddenly dies, we automatically
		// restart it. If not, we consider something must be wrong with the
		// application's code, and stall until either a file is updated or
		// a key is pressed in the terminal
		if (!worker._mageManagedExit) {
			logger.debug('Reloading');
			processManager.getWorkerManager().createWorker(id);
		} else {
			console.log('');
			logger.warning('------------------------------------------------------');
			logger.warning('Worker down, save a file or press any key to reload...');
			logger.warning('------------------------------------------------------');

			var stdin = process.stdin;
			var waiter;

			var kill = () => process.exit();

			process.once('SIGINT', kill);

			function onKeyPress() {
				process.removeListener('SIGINT', kill);

				if (waiter) {
					waiter.close();
				}

				stdin.pause();

				processManager.getWorkerManager().createWorker(id);
			}

			waiter = onceSomeFilesChanged(function (event, name) {
				stdin.removeListener('data', onKeyPress);
				stdin.pause();

				logger.debug('File ' + name + ' was ' + event + 'd, reloading');

				processManager.getWorkerManager().createWorker(id);
			});

			stdin.resume();
			stdin.once('data', onKeyPress);
		}
	});
});

// Clean up old lingering sockets
try {
	fs.unlinkSync(ipcPath);
} catch (error) {
	// do nothing, file was probably not there
}

// Debug port proxy
//
// On older Node version, no programmatic APIs were available
// for us to force-disconnect inspector sessions on process.exit;
// to deal with this issue, we instead proxy the debugger/inspector
// connection through the master, and force a disconnect on our end
// whenever a shutdown is detected
var debuggerConnections = [];

function closeDebuggerConnection({ localSocket, debuggerConnection }) {
	debuggerConnection.unpipe(localSocket);
	localSocket.unpipe(debuggerConnection);

	localSocket.unref();
	debuggerConnection.unref();

	debuggerConnection.end();
	localSocket.end();

	debuggerConnection.destroy();
	localSocket.destroy();
}
function closeDebuggerConnections() {
	debuggerConnections.forEach(closeDebuggerConnection);
	debuggerConnections = [];
}

net.createServer(function (localSocket) {
	var workerDebugPort = debug.getWorkerDebugPort();

	if (!workerDebugPort) {
		return localSocket.end(); // retry later
	}

	var debuggerConnection = net.connect(workerDebugPort);

	debuggerConnection.pipe(localSocket);
	localSocket.pipe(debuggerConnection);

	debuggerConnection.on('error', function (error) {
		if (error.code === 'ECONNREFUSED') {
			return;
		}

		logger.warning('Error raised on the connection to the worker debug port', error);
		closeDebuggerConnection({ localSocket, debuggerConnection });
	});

	localSocket.on('error', function (error) {
		logger.warning('Error raised on the connection to the debugger proxy port', error);
		closeDebuggerConnection({ localSocket, debuggerConnection });
	});

	debuggerConnections.push({ localSocket, debuggerConnection });
}).listen(debug.port);

// If the worker receives SIGINT, it will proceed
// to send a shutdown message to the master process.
// This could eventually be used to pass additional commands
// from the REPL on the worker to the master if needed.
cluster.on('message', function (worker, message) {
	// https://nodejs.org/api/cluster.html#cluster_event_message_1
	if (arguments.length === 2) {
		message = worker;
	}

	switch (message) {
	case 'reload':
		closeDebuggerConnections();
		logger.notice('reloading worker');
		worker.kill();
		break;
	case 'shutdown':
		logger.notice('shutting down');
		cluster.removeAllListeners('exit');
		worker.once('exit', function () {
			closeDebuggerConnections();
			mage.exit();
			process.exit();
		});

		worker.kill();

		break;
	}
});

// Create the server, pipe input/output into the connection
var server = net.createServer(function (client) {
	logger.notice('connected');

	var stdin = process.stdin;
	setRawMode(true);

	stdin.setEncoding('utf8');
	stdin.resume();

	client.pipe(process.stdout);
	stdin.pipe(client);

	client.on('end', function () {
		setRawMode(false);
		stdin.pause();
		logger.notice('disconnected');
	});
});

server.listen(ipcPath, function (error) {
	if (error) {
		return crash(error);
	}

	logger.debug('Exposed console from master process');
});

server.on('error', crash);
