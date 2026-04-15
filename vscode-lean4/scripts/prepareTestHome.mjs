import { prepareTestHome } from './testHome.mjs'

// Prepares the test home without a test run (see `testHome.mjs`). The debug
// configuration of `.vscode/launch.json` starts VS Code without our run
// scripts, so its `preLaunchTask` runs this script.
const { testHome } = prepareTestHome()
console.log(`test home prepared: ${testHome}`)
