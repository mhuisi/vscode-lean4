// Prints the summary at the end of a run: the suites of `runAllTests.mjs` in
// the root, or the labels of `runCliTests.mjs`. `unit` names the results in the
// count, for example `suites`. Each result is `{ name, status, elapsedMs, note }`.
// `note` is optional. If it is set, the line shows it in place of the exit code.
// Returns the failed results.
export function printSummary(title, unit, results) {
    const nameWidth = Math.max(...results.map(r => r.name.length))
    const failed = results.filter(r => r.status !== 0)

    console.log('')
    console.log('─'.repeat(40))
    console.log(title)
    console.log('─'.repeat(40))
    for (const r of results) {
        const mark = r.status === 0 ? '✔' : '✘'
        const time = `${(r.elapsedMs / 1000).toFixed(1)}s`
        const status = r.note !== undefined ? `  (${r.note})` : r.status === 0 ? '' : `  (exit ${r.status})`
        console.log(`  ${mark} ${r.name.padEnd(nameWidth)}  ${time}${status}`)
    }
    console.log('')
    console.log(`  ${results.length - failed.length}/${results.length} ${unit} passed`)
    if (failed.length > 0) {
        console.log(`  failed: ${failed.map(f => f.name).join(', ')}`)
    }
    console.log('')
    return failed
}
