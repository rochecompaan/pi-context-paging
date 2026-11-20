#!/usr/bin/env node
// Fails fast, with a reason, when this Node build cannot run the project's TypeScript test suite.
//
// Why this exists: the suite is `node --test --experimental-strip-types tests/*.test.ts`, which needs a Node build
// compiled with TypeScript support. `engines.node` and the README only promise a version, and a version is not
// enough: a build reporting `process.features.typescript === false` (measured on a distro-packaged v22.22.1, a
// version inside the declared range) throws ERR_NO_TYPESCRIPT for every `.ts` file, so `npm test` ends as ~65
// failing test files whose only shared cause is an internal stack trace. Exit 1 here names the build and the fix.
//
// Scope: this is a development-time requirement. Installed users are unaffected — the host loads `.ts` extensions
// through its own jiti loader (see the host's dist/bundle/chunks/jiti-loader-*.js), not Node's transpiler.
if (process.features.typescript) process.exit(0);

const version = process.version;
console.error(`Node ${version} at ${process.execPath} is not compiled with TypeScript support`
	+ ` (process.features.typescript === ${JSON.stringify(process.features.typescript)}).`);
console.error("The test suite runs `node --test --experimental-strip-types`, which needs a Node build compiled"
	+ " with TypeScript support; on this build every .ts file fails to load with ERR_NO_TYPESCRIPT.");
console.error("Use a Node build with TypeScript support (a nodejs.org binary or an nvm install) — the version"
	+ " number alone is not sufficient. Loading this extension inside pi is unaffected: pi transpiles .ts"
	+ " extensions with its own jiti loader.");
process.exit(1);
