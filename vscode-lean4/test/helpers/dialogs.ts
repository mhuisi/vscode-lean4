import * as sinon from 'sinon'
import { OpenDialogOptions, SaveDialogOptions, Uri, window } from 'vscode'
import { trackStubs } from './stubs'

// Replace `window.showSaveDialog` and `showOpenDialog` while `body` runs.
// Each call gets the same answer. `log` records the calls.

export interface SaveDialogLog {
    options: SaveDialogOptions | undefined
    chose: Uri | undefined
}

export async function withSaveDialog<T>(
    answer: Uri | undefined,
    body: (capture: { log: SaveDialogLog[] }) => Promise<T>,
): Promise<T> {
    const log: SaveDialogLog[] = []
    const stub = sinon.stub(window, 'showSaveDialog').callsFake((async (options?: SaveDialogOptions) => {
        log.push({ options, chose: answer })
        return answer
    }) as never)
    const restore = trackStubs([stub])
    try {
        return await body({ log })
    } finally {
        restore()
    }
}

export interface OpenDialogLog {
    options: OpenDialogOptions | undefined
    chose: Uri[] | undefined
}

export async function withOpenDialog<T>(
    answer: Uri[] | undefined,
    body: (capture: { log: OpenDialogLog[] }) => Promise<T>,
): Promise<T> {
    const log: OpenDialogLog[] = []
    const stub = sinon.stub(window, 'showOpenDialog').callsFake((async (options?: OpenDialogOptions) => {
        log.push({ options, chose: answer })
        return answer
    }) as never)
    const restore = trackStubs([stub])
    try {
        return await body({ log })
    } finally {
        restore()
    }
}
