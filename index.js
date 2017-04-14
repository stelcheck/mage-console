#!/usr/bin/env node

'use strict';

var repl = require('repl');
var net = require('net');
var cluster = require('cluster');
var chalk = require('chalk');
var path = require('path');
var fs = require('fs');
var MemoryStream = require('memorystream');

/**
 * Boot mage
 */
var cwd = process.cwd();
var libPath = path.join(cwd, 'lib');
var mage = require(libPath);

process.on('uncaughtException', function (error) {
	if (!mage.logger) {
		console.error(error);
		process.exit(-1);
	}
});

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

/**
 * @summary Retrieve the IPC path on which to listen/connect to
 * @returns {String} path the master process will listen on
 */
function getIPCPath() {
	if (process.platform === 'win32') {
		return path.join('\\\\.\\pipe', __dirname, 'mage-console.sock');
	}

	return path.join(__dirname, 'mage-console.sock');
}

var ipcPath = getIPCPath();

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

	instance.context.mage = mage;
	instance.on('exit', function () {
		process.send('shutdown');
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

	var client = net.connect(ipcPath, function () {
		// Prompt and REPL configuration
		var prompt = chalk.blue.bold('(' + process.pid + ') ') +
				chalk.cyan('mage/' + mage.rootPackage.name) +
				chalk.magenta(' >> ');

		var promptLength = chalk.stripColor(prompt).length;
		var repl = createRepl(client, prompt);

		// All MAGE logs are sent on stderr; we capture its output,
		// and proceed to read it line by line
		var stream = new MemoryStream();
		var realStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write =  stream.write.bind(stream);

		var readline = require('readline').createInterface({
			input: stream
		});

		// Once we have printed lines, we automatically
		// reset the prompt. The delay is there
		// because Node.js needs some time to actually
		// print output onto the console on Linux and macOS
		// (were logging is asynchronous)
		var timeout = null;

		function scheduleReset(lineContent) {
			if (timeout) {
				clearTimeout(timeout);
			}

			setTimeout(function () {
				repl.line = lineContent;
				repl.lineParser.reset();
				repl.displayPrompt(true);
			}, 50);
		}

		readline.on('line', function (data) {
			// Buffer the current REPL line content
			var lineContent = repl.line;

			// Wipe the printed line - done like this to ensure
			// cross-platform compatibility
			const wipeLine = (new Array(lineContent.length + promptLength + 1)).join(' ');
			realStderrWrite(`\r${wipeLine}\r`);
			realStderrWrite(data + '\n');

			scheduleReset(lineContent);
		});
	});

	client.once('end', connect);
}

// Workers connect to the master process
if (cluster.isWorker) {
	return setTimeout(connect, 1000);
}

// Master process provides a network server for process
// to connect to, and patches stdin/stdout/stderr into
// the connection

// Clean up old lingering sockets
try {
	fs.unlinkSync(ipcPath);
} catch (error) {
	// do nothing, file was probably not there
}

// If the worker receives SIGINT, it will proceed
// to send a shutdown message to the master process.
// This could eventually be used to pass additional commands
// from the REPL on the worker to the master if needed.
cluster.on('message', function (worker, message) {
	// https://nodejs.org/api/cluster.html#cluster_event_message_1
	if (arguments.length === 2) {
		message = worker;
	}

	logger.debug('received message', message);

	switch (message) {
	case 'shutdown':
		mage.quit();
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
		logger.emergency(error);
		return mage.quit(-1);
	}

	logger.debug('Exposed console from master process');
});

