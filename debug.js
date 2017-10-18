var semver = require('semver');

/**
 * This function maps the current behaviour of the 'auto' flag
 * in VSCode's launch/attach task definitions.
 *
 * Ref: https://code.visualstudio.com/docs/nodejs/nodejs-debugging#_supported-nodelike-runtimes
 *
 * @returns {string} The debug flag to pass to fork when starting a worker
 */
exports.getDebugFlagName = function () {
	var version = process.version;

	if (semver.lt(version, '8.0.0')) {
		return '--debug';
	}

	return '--inspect';
};

/**
 *
 *
 * @returns
 */
exports.getDebugFlagHost = function () {
	return process.env.DEBUG_HOST || '127.0.0.1';
};

/**
 * Debug port to listen on
 */
exports.port = 5858;

/**
 * @param {string} flag Debug flag currrently used
 */
exports.setDebugPortForFlag = function (flag) {
	if (flag === '--debug') {
		this.port = 5858;
	} else {
		this.port = 9229;
	}
};

let workerPort = 2501; // GisT!

/**
 * @returns {Number} Port value
 */
exports.getWorkerDebugPort = function () {
	return workerPort;
};

exports.incrementDebugPort = function () {
	return workerPort += 1;
};

exports.applyCPForkFlagsHack = function (execArgv, debugFlag) {
	execArgv = execArgv.filter(function (flag) {
		return !flag.match(/^(--inspect|--debug)/);
	});

	execArgv.unshift(debugFlag);
	return execArgv;
};
