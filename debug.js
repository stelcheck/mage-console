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
 * @param {string} flag Debug flag currrently used
 * @returns {Number} Port value
 */
exports.getDebugFlagPort = function (flag) {
	if (flag === '--debug') {
		return 5858;
	}

	return 9229;
};

exports.applyCPForkFlagsHack = function (execArgv, debugFlag) {
	for (var i = 0; i < execArgv.length; i++) {
		var match = execArgv[i].match(
			/^(--inspect|--debug)=(\d+)?$/
		);

		if (match) {
			execArgv[i] = debugFlag;
			break;
		}
	}
};
