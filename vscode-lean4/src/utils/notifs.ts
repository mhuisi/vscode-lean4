/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
import { Disposable, MessageItem, MessageOptions, commands, window } from 'vscode'
import { lean } from './leanEditorProvider'

// All calls to window.show(Error|Warning|Information)... should go through functions in this file
// to prevent accidentally blocking the VS Code extension.
// Specifically, we want to enforce the following invariants:
// - Notifications without input should never block the extension
// - Notifications with optional input should never block the extension
// - Notifications that block the extension must be modal

export type NotificationSeverity = 'Information' | 'Warning' | 'Error'

type Notification = <T extends string>(
    message: string,
    options: MessageOptions,
    ...items: T[]
) => Thenable<T | undefined>

function toNotif(severity: NotificationSeverity): Notification {
    switch (severity) {
        case 'Information':
            return window.showInformationMessage
        case 'Warning':
            return window.showWarningMessage
        case 'Error':
            return window.showErrorMessage
    }
}

export async function setStickyNotificationActiveButHidden(isActiveButHidden: boolean) {
    await commands.executeCommand('setContext', 'lean4.isStickyNotificationActiveButHidden', isActiveButHidden)
}

export type StickyNotificationOptions<T> = {
    onInput: (lastChoice: T, continueDisplaying: boolean) => Promise<boolean>
    onDisplay: () => Promise<void>
}

type StickyNotification<T> = {
    displayNotification: () => Promise<T | undefined>
    options: StickyNotificationOptions<T>
}

let activeStickyNotification: StickyNotification<any> | undefined
let nextStickyNotification: StickyNotification<any> | undefined
let activeDisplayFn: (() => Promise<void>) | undefined

function makeSticky<T>(n: StickyNotification<T>): Disposable {
    if (activeStickyNotification !== undefined) {
        nextStickyNotification = n
        return Disposable.from()
    }
    activeStickyNotification = n

    let isDisplaying = false

    // eslint-disable-next-line prefer-const
    let d: Disposable | undefined

    const display: () => Promise<void> = async () => {
        if (isDisplaying) {
            return
        }
        await setStickyNotificationActiveButHidden(false)
        isDisplaying = true
        try {
            await activeStickyNotification?.options.onDisplay()
            let gotNewStickyNotification: boolean = false
            let r: any
            let continueDisplaying: boolean
            do {
                gotNewStickyNotification = false
                r = await activeStickyNotification?.displayNotification()
                continueDisplaying =
                    r === undefined || ((await activeStickyNotification?.options.onInput(r, true)) ?? false)
                if (nextStickyNotification !== undefined) {
                    activeStickyNotification = nextStickyNotification
                    nextStickyNotification = undefined
                    gotNewStickyNotification = true
                }
            } while ((r !== undefined && continueDisplaying) || gotNewStickyNotification)
            if (!continueDisplaying) {
                activeStickyNotification = undefined
                await setStickyNotificationActiveButHidden(false)
                d?.dispose()
            } else {
                await setStickyNotificationActiveButHidden(true)
            }
        } catch (e) {
            activeStickyNotification = undefined
            nextStickyNotification = undefined
            await setStickyNotificationActiveButHidden(false)
            d?.dispose()
        } finally {
            isDisplaying = false
        }
    }
    activeDisplayFn = display

    d = Disposable.from(
        lean.onDidRevealLeanEditor(async () => await display()),
        {
            dispose: () => {
                activeStickyNotification = undefined
                activeDisplayFn = undefined
            },
        },
    )
    void display()

    return d
}

export function displayActiveStickyNotification() {
    if (activeDisplayFn !== undefined) {
        void activeDisplayFn()
    }
}

export function displayNotification(
    severity: NotificationSeverity,
    message: string,
    finalizer?: (() => void) | undefined,
) {
    void (async () => {
        await toNotif(severity)(message, {})
        if (finalizer) {
            finalizer()
        }
    })()
}

export function displayStickyNotification(
    severity: NotificationSeverity,
    message: string,
    options: StickyNotificationOptions<void>,
): Disposable {
    return makeSticky({
        displayNotification: async () => (await toNotif(severity)(message, {})) as undefined,
        options,
    })
}

export async function displayNotificationWithInput<T extends string>(
    severity: NotificationSeverity,
    message: string,
    items: T[],
    defaultItem?: T | undefined,
): Promise<T | undefined> {
    if (defaultItem === undefined) {
        // VS Code renders buttons for modal notifications in the reverse order (which it doesn't do for non-modal notifications),
        // so we reverse them for consistency.
        // The close button is placed to the left of the primary button.
        return await toNotif(severity)(message, { modal: true }, ...[...items].reverse())
    }

    let notif: <V extends MessageItem>(
        message: string,
        options: MessageOptions,
        ...items: V[]
    ) => Thenable<V | undefined>
    switch (severity) {
        case 'Information':
            notif = window.showInformationMessage
            break
        case 'Warning':
            notif = window.showWarningMessage
            break
        case 'Error':
            notif = window.showErrorMessage
            break
    }
    const messageItems = items.map(item => ({
        title: item,
        isCloseAffordance: false,
    }))
    // VS Code always moves the `isCloseAffordance: true` button to the left of the primary button.
    messageItems.push({
        title: defaultItem,
        isCloseAffordance: true,
    })
    messageItems.reverse()
    const choice = await notif(message, { modal: true }, ...messageItems)
    return choice?.title
}

export async function displayModalNotification(severity: NotificationSeverity, message: string) {
    await displayNotificationWithInput(severity, message, [], 'Close')
}

export type Input<T> = { input: T; action: () => void }

export function displayNotificationWithOptionalInput<T extends string>(
    severity: NotificationSeverity,
    message: string,
    inputs: Input<T>[],
    finalizer?: (() => void) | undefined,
) {
    void (async () => {
        const choice = await toNotif(severity)(message, {}, ...inputs.map(i => i.input))
        const chosenInput = inputs.find(i => i.input === choice)
        if (chosenInput !== undefined) {
            chosenInput.action()
        }
        if (finalizer) {
            finalizer()
        }
    })()
}

export type StickyInput<T> = { input: T; continueDisplaying: boolean; action: () => Promise<void> }

export function displayStickyNotificationWithOptionalInput<T extends string>(
    severity: NotificationSeverity,
    message: string,
    options: StickyNotificationOptions<T>,
    inputs: StickyInput<T>[],
): Disposable {
    const updatedOptions: StickyNotificationOptions<T> = {
        ...options,
        onInput: async (lastChoice, continueDisplaying) => {
            const chosenInput = inputs.find(i => i.input === lastChoice)
            if (chosenInput !== undefined) {
                await chosenInput.action()
                continueDisplaying = chosenInput.continueDisplaying
            }
            return options.onInput(lastChoice, continueDisplaying)
        },
    }
    return makeSticky({
        displayNotification: async () => await toNotif(severity)(message, {}, ...inputs.map(i => i.input)),
        options: updatedOptions,
    })
}

export function displayNotificationWithOutput(
    severity: NotificationSeverity,
    message: string,
    otherInputs: Input<string>[] = [],
    finalizer?: (() => void) | undefined,
) {
    displayNotificationWithOptionalInput(
        severity,
        message,
        [
            { input: 'Show Output', action: () => commands.executeCommand('lean4.troubleshooting.showOutput') },
            ...otherInputs,
        ],
        finalizer,
    )
}

export async function displayModalNotificationWithOutput(
    severity: NotificationSeverity,
    message: string,
    otherItems: string[] = [],
    defaultItem?: string | undefined,
): Promise<'Show Output' | string | undefined> {
    const choice = await displayNotificationWithInput(severity, message, ['Show Output', ...otherItems], defaultItem)
    if (choice === 'Show Output') {
        await commands.executeCommand('lean4.troubleshooting.showOutput')
    }
    return choice
}

export function displayStickyNotificationWithOutput(
    severity: NotificationSeverity,
    message: string,
    options: StickyNotificationOptions<'Show Output' | string>,
    otherInputs: StickyInput<string>[] = [],
): Disposable {
    const showOutputItem: StickyInput<'Show Output'> = {
        input: 'Show Output',
        continueDisplaying: true,
        action: async () => await commands.executeCommand('lean4.troubleshooting.showOutput'),
    }
    return displayStickyNotificationWithOptionalInput(severity, message, options, [showOutputItem, ...otherInputs])
}

export function displayNotificationWithSetupGuide(
    severity: NotificationSeverity,
    message: string,
    otherInputs: Input<string>[] = [],
    finalizer?: (() => void) | undefined,
) {
    displayNotificationWithOptionalInput(
        severity,
        message,
        [
            { input: 'Open Setup Guide', action: () => commands.executeCommand('lean4.docs.showSetupGuide') },
            ...otherInputs,
        ],
        finalizer,
    )
}

export function displayStickyNotificationWithSetupGuide(
    severity: NotificationSeverity,
    message: string,
    options: StickyNotificationOptions<'Open Setup Guide' | string>,
    otherInputs: StickyInput<string>[] = [],
): Disposable {
    const openSetupGuideItem: StickyInput<'Open Setup Guide'> = {
        input: 'Open Setup Guide',
        continueDisplaying: true,
        action: async () => await commands.executeCommand('lean4.docs.showSetupGuide'),
    }
    return displayStickyNotificationWithOptionalInput(severity, message, options, [openSetupGuideItem, ...otherInputs])
}

export async function displayModalNotificationWithSetupGuide(
    severity: NotificationSeverity,
    message: string,
    otherItems: string[] = [],
    defaultItem?: string | undefined,
): Promise<'Open Setup Guide' | string | undefined> {
    const choice = await displayNotificationWithInput(
        severity,
        message,
        ['Open Setup Guide', ...otherItems],
        defaultItem,
    )
    if (choice === 'Open Setup Guide') {
        await commands.executeCommand('lean4.docs.showSetupGuide')
    }
    return choice
}
