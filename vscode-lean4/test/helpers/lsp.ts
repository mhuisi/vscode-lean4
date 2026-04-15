import { Diagnostic, DiagnosticSeverity, Uri, languages } from 'vscode'

// Resolves when `predicate` holds for the diagnostics of `uri`: at once if it
// holds already, else at the first change for which it holds.
//
// A change does not show what caused it. For example, an elaboration that
// still runs can change the diagnostics after a restart. Thus, to see the
// effect of an action, the predicate must match only the new state (see
// `server-launch.test.ts`).
export function waitForDiagnostics(
    uri: Uri,
    predicate: (d: Diagnostic[]) => boolean,
    timeoutMs: number,
    label = 'diagnostics',
): Promise<Diagnostic[]> {
    const initial = languages.getDiagnostics(uri)
    if (predicate(initial)) return Promise.resolve(initial)
    return new Promise((resolve, reject) => {
        const sub = languages.onDidChangeDiagnostics(e => {
            if (!e.uris.some(u => u.toString() === uri.toString())) return
            const diags = languages.getDiagnostics(uri)
            console.log(
                `[${label}] ${uri.fsPath}: ${diags.length} diagnostic(s)` +
                    (diags.length
                        ? ' — ' +
                          diags.map(d => `${DiagnosticSeverity[d.severity]}: ${d.message.split('\n')[0]}`).join('; ')
                        : ''),
            )
            if (predicate(diags)) {
                sub.dispose()
                clearTimeout(timer)
                resolve(diags)
            }
        })
        const timer = setTimeout(() => {
            sub.dispose()
            reject(
                new Error(
                    `[${label}] timed out after ${timeoutMs}ms waiting for diagnostics on ${uri.fsPath}. ` +
                        `Latest: ${JSON.stringify(languages.getDiagnostics(uri).map(d => d.message))}`,
                ),
            )
        }, timeoutMs)
    })
}

export const hasError = (diags: Diagnostic[]) => diags.some(d => d.severity === DiagnosticSeverity.Error)

// Matches an error diagnostic that contains `text`.
export const hasErrorIncluding = (text: string) => (diags: Diagnostic[]) =>
    diags.some(d => d.severity === DiagnosticSeverity.Error && d.message.includes(text))

// Matches an information diagnostic that contains `text`, for example the output of `#eval`.
export const hasInfoIncluding = (text: string) => (diags: Diagnostic[]) =>
    diags.some(d => d.severity === DiagnosticSeverity.Information && d.message.includes(text))
