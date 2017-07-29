'use strict';

var repl = require('repl');
var net = require('net');
var chalk = require('chalk');
var path = require('path');
var cluster = require('cluster');
var fs = require('fs');
var watch = require('node-watch');
var MemoryStream = require('memorystream');

var HISTORY_FILE = path.join(process.env.HOME, '.mage-history.json');
var APP_LIB_PATH = path.join(process.cwd(), 'lib');

var debug = require('./debug');

function watchFiles(onChange) {
	watch(APP_LIB_PATH, {
		recursive: true
	}, function (event, name) {
		if (name.split(path.sep).pop()[0] === '.') {
			return;
		}

		onChange(event, name);
	});
}

/**
 * exports.eval can be used to customise how the code and commands
 * will be interpreted in the REPL interface - null means default node
 * behaviour
 */
exports.eval = null;

/**
 * Additional prefix to set on the REPL's prompt
 */
exports.promptPrefix = '';

/**
 * Debug flag to use
 */
exports.debugFlag = '--debug';

/**
 * Boot mage
 */
var mage = require(APP_LIB_PATH);
var processManager = mage.core.processManager;

mage.boot();

var clusterConfiguration = mage.core.config.get('server.cluster');

if (clusterConfiguration !== 1) {
	console.error('');
	console.error('mage-console requires your application to be configured with');
	console.error('"server.cluster" to 1. Please change your configuration and try again');
	console.error('');

	process.exit(-1);
}

var logger = mage.core.logger.context('REPL');

function crash(error) {
	mage.logger.error(error);
	mage.quit();
}

/**
 * @summary Retrieve the IPC path on which to listen/connect to
 * @returns {String} path the master process will listen on
 */
function getIPCPath() {
	// See https://github.com/nodejs/node/issues/13670 for more details
	const defaultFilepath = path.relative(process.cwd(), path.join(__dirname, 'mage-console.sock'));
	const filepath = mage.core.config.get('external.mage-console.sockfile') || defaultFilepath;

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
		prompt: prompt,
		eval: exports.eval
	});

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

		var promptLength = chalk.stripColor(prompt).length;
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

		function schedulePrompt(lineContent) {
			if (closing) {
				return;
			}

			if (scheduled) {
				clearTimeout(scheduled);
			}

			scheduled = setTimeout(function () {
				realStderrWrite(prompt);
				realStderrWrite(lineContent);
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

			schedulePrompt(lineContent);
		});

		// Watch the lib folder for changes
		watchFiles(function (event, name) {
			logger.debug('File ' + name + ' was ' + event + 'd, reloading');
			saveHistory(repl.history);
			process.send('reload');
		});
	});

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
// the connection

cluster.removeAllListeners('exit');
cluster.on('exit', function (worker) {
	// check if the worker was supposed to die

	if (!worker._mageManagedExit) {
		// this exit was not supposed to happen!
		// spawn a new worker to replace the dead one

		processManager.emit('workerOffline', worker.id);
		watchFiles(function (event, name) {
			logger.debug('File ' + name + ' was ' + event + 'd, reloading');
			processManager.createWorker();
		});
	} else {
		if (!processManager.getNumWorkers()) {
			logger.emergency('All workers have shut down, shutting down master now.');
			process.exit(0);
		}
	}
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

function closeDebuggerConnection() {
	debuggerConnections.forEach(function ({ localSocket, debuggerConnection }) {
		debuggerConnection.unpipe(localSocket);
		localSocket.unpipe(debuggerConnection);

		localSocket.unref();
		debuggerConnection.unref();

		debuggerConnection.end();
		localSocket.end();
	});

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
		closeDebuggerConnection();
		logger.notice('reloading worker');
		mage.core.processManager.reload(function () {
			logger.notice('worker reloaded');
		});
		break;
	case 'shutdown':
		closeDebuggerConnection();
		logger.notice('shutting down');
		mage.quit();
		break;
	}
});

// Create the server, pipe input/output into the connection
var server = net.createServer(function (client) {
	logger.notice('connected');

	var stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.setEncoding('utf8');
	stdin.resume();

	client.pipe(process.stdout);
	stdin.pipe(client);

	client.on('end', function () {
		stdin.setRawMode(false);
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
