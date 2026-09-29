/*
 * Headless QUnit runner for the jQuery browser test suite (used by .travis.yml).
 *
 * Loads test/index.html from a local web server (PHP is required for the ajax
 * tests, e.g. `PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8000` from the repo
 * root; more than one worker is needed because test/data/core/dont_return.php
 * deliberately hangs for 30s) in a headless browser via puppeteer-core, prints
 * every failing assertion, one line per module and a final summary, and exits
 * non-zero on any failure, on "no tests ran" or on timeout.
 *
 * This script needs a modern Node (>= 18) and puppeteer-core >= 23; it is NOT
 * run by the package's own node 0.10 toolchain. Install puppeteer-core outside
 * the repository and point NODE_PATH at it, e.g.:
 *
 *   npm install --prefix /tmp/qunit-runner puppeteer-core@23
 *   NODE_PATH=/tmp/qunit-runner/node_modules node test/travis-qunit.js
 *
 * Environment:
 *   QUNIT_URL      page to load (default http://127.0.0.1:8000/test/index.html)
 *   QUNIT_BROWSER  "firefox" (default, WebDriver BiDi) or "chrome"
 *   BROWSER_BIN    browser executable (default: first matching binary on PATH)
 *   QUNIT_TIMEOUT  overall timeout in seconds (default 900)
 */
"use strict";

const fs = require( "fs" );
const path = require( "path" );
const puppeteer = require( "puppeteer-core" );

const url = process.env.QUNIT_URL || "http://127.0.0.1:8000/test/index.html";
const timeoutSec = parseInt( process.env.QUNIT_TIMEOUT || "900", 10 );
const browserName = ( process.env.QUNIT_BROWSER || "firefox" ).toLowerCase();

// Tests that cannot pass in a current headless browser for reasons unrelated
// to jQuery itself (the suite targets 2014-era browsers). Each entry is one
// exact module + test name; skipped tests are printed and counted in the
// summary. Keep this list as small as possible.
const SKIP = {
	firefox: [ {
		module: "support",
		name: "Check CSP (https://developer.mozilla.org/en-US/docs/Security/CSP) restrictions",
		reason: "modern Firefox reports a CSP script-src-attr violation for the inline " +
			"'onfocusin' feature probe in jQuery 1.11 support code; the report races the " +
			"csp.log read, so the test passes or fails at random"
	} ],
	chrome: [ {
		module: "ajax",
		name: "#14379 - jQuery.ajax() on unload",
		reason: "Chrome >= 80 forbids synchronous XHR during page dismissal"
	}, {
		module: "offset",
		name: "fractions (see #7730 and #7885)",
		reason: "modern Chrome sub-pixel layout returns 999.984375 instead of 1000"
	} ]
};

function findBrowser() {
	if ( process.env.BROWSER_BIN ) {
		return process.env.BROWSER_BIN;
	}
	const names = browserName === "firefox" ?
		[ "firefox" ] :
		[ "google-chrome", "google-chrome-stable", "chromium", "chromium-browser" ];
	const dirs = ( process.env.PATH || "" ).split( path.delimiter );
	for ( const name of names ) {
		for ( const dir of dirs ) {
			const candidate = path.join( dir, name );
			try {
				fs.accessSync( candidate, fs.constants.X_OK );
				return candidate;
			} catch ( e ) {}
		}
	}
	throw new Error( "No " + browserName + " binary found on PATH; set BROWSER_BIN" );
}

// Runs in the page before any page script. QUnit 1.14 assigns window.QUnit at
// the end of qunit.js (after exporting test/asyncTest globals) and the suite
// starts it later (autostart=false), so a setter trap lets us register the
// logging callbacks and the skip filter before any test is defined or run.
function installHooks( skipList ) {
	if ( window !== window.top ) {
		return;
	}
	let qunit;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		get: function() {
			return qunit;
		},
		set: function( value ) {
			qunit = value;
			if ( !value || value.__travisHooked ) {
				return;
			}
			value.__travisHooked = true;

			const wrap = function( orig ) {
				return function( name ) {
					const module = value.config.currentModule;
					for ( const s of skipList ) {
						if ( s.module === module && s.name === name ) {
							window.__qunitReport( "skip", { module: module, name: name, reason: s.reason } );
							return;
						}
					}
					return orig.apply( this, arguments );
				};
			};
			[ "test", "asyncTest" ].forEach( function( fn ) {
				if ( typeof value[ fn ] === "function" ) {
					value[ fn ] = wrap( value[ fn ] );
				}
				if ( typeof window[ fn ] === "function" ) {
					window[ fn ] = wrap( window[ fn ] );
				}
			} );

			value.log( function( d ) {
				if ( !d.result ) {
					window.__qunitReport( "fail", {
						module: d.module,
						name: d.name,
						message: d.message,
						actual: d.actual,
						expected: d.expected,
						source: d.source
					} );
				}
			} );
			value.testDone( function( d ) {
				window.__qunitReport( "testDone", {
					module: d.module, name: d.name, failed: d.failed, passed: d.passed, total: d.total
				} );
			} );
			value.moduleDone( function( d ) {
				window.__qunitReport( "moduleDone", {
					name: d.name, failed: d.failed, passed: d.passed, total: d.total
				} );
			} );
			value.done( function( d ) {
				window.__qunitReport( "done", {
					failed: d.failed, passed: d.passed, total: d.total, runtime: d.runtime
				} );
			} );
		}
	} );
}

function fmt( value ) {
	if ( value === undefined ) {
		return "undefined";
	}
	try {
		const s = JSON.stringify( value );
		return s === undefined ? String( value ) : s;
	} catch ( e ) {
		return String( value );
	}
}

async function main() {
	const launchOptions = browserName === "firefox" ? {
		browser: "firefox",
		protocol: "webDriverBiDi",
		executablePath: findBrowser(),
		headless: true,
		// PHP's built-in server runs one request at a time per worker, and
		// test/data/core/dont_return.php sleeps 30s. An idle speculative
		// connection that lands on the sleeping worker stalls whatever request
		// Firefox later sends on it, so keep Firefox from opening them.
		extraPrefsFirefox: {
			"network.http.speculative-parallel-limit": 0,
			"network.predictor.enabled": false,
			"network.prefetch-next": false,
			"network.dns.disablePrefetch": true
		}
	} : {
		browser: "chrome",
		executablePath: findBrowser(),
		headless: true,
		args: [ "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu" ]
	};
	const skipList = SKIP[ browserName ] || [];
	const browser = await puppeteer.launch( launchOptions );
	console.log( "Browser: " + await browser.version() );

	let tests = 0;
	let testsFailed = 0;
	let skipped = 0;
	let finished = false;
	let resolveDone;
	const done = new Promise( function( resolve ) {
		resolveDone = resolve;
	} );

	const page = await browser.newPage();
	await page.setViewport( { width: 1280, height: 1024 } );
	await page.exposeFunction( "__qunitReport", function( type, d ) {
		if ( type === "fail" ) {
			console.log( "FAIL: " + d.module + " :: " + d.name + " :: " + ( d.message || "(no message)" ) );
			if ( "expected" in d || "actual" in d ) {
				console.log( "      expected: " + fmt( d.expected ) + "  actual: " + fmt( d.actual ) );
			}
			if ( d.source ) {
				console.log( "      " + String( d.source ).split( "\n" ).slice( 0, 3 ).join( "\n      " ) );
			}
		} else if ( type === "skip" ) {
			skipped++;
			console.log( "SKIPPED: " + d.module + " :: " + d.name + " -- " + d.reason );
		} else if ( type === "testDone" ) {
			tests++;
			if ( d.failed ) {
				testsFailed++;
				console.log( "  not ok - " + d.module + " :: " + d.name +
					" (" + d.failed + " failed, " + d.passed + " passed)" );
			}
		} else if ( type === "moduleDone" ) {
			console.log( "Module " + d.name + ": " + d.passed + " passed, " + d.failed +
				" failed, " + d.total + " total" );
		} else if ( type === "done" ) {
			finished = true;
			resolveDone( d );
		}
	} );
	page.on( "pageerror", function( err ) {
		console.log( "page error (non-fatal): " + ( err && err.message ? err.message : err ) );
	} );
	page.on( "dialog", function( dialog ) {
		dialog.dismiss().catch( function() {} );
	} );
	await page.evaluateOnNewDocument( installHooks, skipList );

	console.log( "Loading " + url );
	const response = await page.goto( url, { waitUntil: "domcontentloaded", timeout: 60000 } );
	if ( !response || !response.ok() ) {
		throw new Error( "Could not load " + url + " (HTTP " + ( response && response.status() ) + ")" );
	}

	let timer;
	const timeout = new Promise( function( resolve ) {
		timer = setTimeout( resolve, timeoutSec * 1000 );
	} );
	const result = await Promise.race( [ done, timeout ] );
	clearTimeout( timer );

	let code;
	if ( !finished ) {
		console.log( "QUnit: TIMEOUT after " + timeoutSec + "s (" + tests + " tests completed)" );
		code = 1;
	} else {
		console.log( "QUnit: " + result.passed + " assertions passed, " + result.failed + " failed, " +
			result.total + " total in " + tests + " tests (" + testsFailed + " tests failed, " +
			skipped + " skipped, " + result.runtime + "ms)" );
		if ( tests === 0 || result.total === 0 ) {
			console.log( "QUnit: no tests ran" );
			code = 1;
		} else {
			code = result.failed === 0 ? 0 : 1;
		}
	}

	// In-flight protocol calls reject once the browser goes away; the verdict
	// is already decided, so ignore them from here on.
	closing = true;
	await browser.close().catch( function() {} );
	return code;
}

let closing = false;
process.on( "unhandledRejection", function( err ) {
	if ( closing ) {
		return;
	}
	console.error( "Runner error: " + ( err && err.stack ? err.stack : err ) );
	process.exit( 2 );
} );

main().then( function( code ) {
	process.exit( code );
}, function( err ) {
	console.error( "Runner error: " + ( err && err.stack ? err.stack : err ) );
	process.exit( 2 );
} );
