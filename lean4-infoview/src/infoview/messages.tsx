import * as React from 'react'
import fastIsEqual from 'react-fast-compare'
import { Diagnostic, DiagnosticSeverity, DocumentUri, Location, Position, Range } from 'vscode-languageserver-protocol'

import {
    HighlightedMsgEmbed,
    highlightMatches,
    LeanDiagnostic,
    LeanPublishDiagnosticsParams,
    MessageOrder,
    RpcErrorCode,
    TaggedText,
} from '@leanprover/infoview-api'

import { getInteractiveDiagnostics, InteractiveDiagnostic } from '@leanprover/infoview-api'
import { VscodeTextfield } from '@vscode-elements/react-elements'
import { Details } from './collapsing'
import { CapabilityContext, ConfigContext, EditorContext, EnvPosContext, LspDiagnosticsContext } from './contexts'
import { RpcContext, useRpcSessionAtPos } from './rpcSessions'
import { InteractiveMessage } from './traceExplorer'
import {
    addUniqueKeys,
    basename,
    count,
    DocumentPosition,
    escapeHtml,
    Keyed,
    PositionHelpers,
    useEvent,
    useEventResult,
    usePausableState,
    useServerNotificationState,
} from './util'

interface MessageViewProps {
    uri: DocumentUri
    diag: InteractiveDiagnostic
}

function isTraceMessage(message: TaggedText<HighlightedMsgEmbed>): boolean {
    if ('text' in message) {
        return false
    }
    if ('append' in message) {
        return message.append.some(m => isTraceMessage(m))
    }
    const embed = message.tag[0]
    if (embed === 'highlighted' || !('trace' in embed)) {
        return false
    }
    return true
}

const MessageView = React.memo(({ uri, diag }: MessageViewProps) => {
    const ec = React.useContext(EditorContext)
    const fname = escapeHtml(basename(uri))
    const { line, character } = diag.range.start
    const loc: Location = { uri, range: diag.range }
    /* We grab the text contents of the message from `node.innerText`. */
    const node = React.useRef<HTMLDivElement>(null)
    const severityClass = diag.severity
        ? {
              [DiagnosticSeverity.Error]: 'error',
              [DiagnosticSeverity.Warning]: 'warning',
              [DiagnosticSeverity.Information]: 'information',
              [DiagnosticSeverity.Hint]: 'hint',
          }[diag.severity]
        : ''
    const title = `${fname}:${line + 1}:${character}`
    const startPos: DocumentPosition = React.useMemo(
        () => ({ uri, ...(diag.fullRange?.start || diag.range.start) }),
        [uri, diag.fullRange, diag.range],
    )

    const cc = React.useContext(CapabilityContext)
    const serverSupportsTraceSearch = cc?.experimental?.rpcProvider?.highlightMatchesProvider !== undefined
    const [msg, setMsg] = React.useState<TaggedText<HighlightedMsgEmbed>>(diag.message)
    const isMessageWithTraceSearch = serverSupportsTraceSearch && isTraceMessage(msg)
    const [isSearchWidgetDisplayed, setSearchWidgetDisplayed] = React.useState(false)
    const [traceSearchMessage, setTraceSearchMessage] = React.useState('')

    const messageId = React.useId()
    const context: { [k: string]: any } = {}
    const useContextMenuEvent = (
        name: string,
        action: () => void,
        isEnabled: boolean,
        dependencies?: React.DependencyList,
    ) => {
        if (isEnabled) {
            context[name + 'Id'] = messageId
        }
        useEvent(ec.events.clickedContextMenu, _ => action(), dependencies, `${name}:${messageId}`)
    }
    useContextMenuEvent('goToMessageLocation', () => void ec.revealLocation(loc), true, [loc])
    useContextMenuEvent(
        'copyMessage',
        () => {
            if (node.current) {
                void ec.api.copyToClipboard(node.current.innerText)
            }
        },
        true,
        [loc],
    )
    useContextMenuEvent(
        'hideTraceSearch',
        () => setSearchWidgetDisplayed(false),
        isMessageWithTraceSearch && isSearchWidgetDisplayed,
        [],
    )
    useContextMenuEvent(
        'showTraceSearch',
        () => setSearchWidgetDisplayed(true),
        isMessageWithTraceSearch && !isSearchWidgetDisplayed,
        [],
    )

    const rs = useRpcSessionAtPos(startPos)

    const search = React.useCallback(async () => {
        if (traceSearchMessage === '') {
            setMsg(diag.message)
        }
        const r = await highlightMatches(rs, traceSearchMessage, diag.message)
        setMsg(r)
    }, [rs, traceSearchMessage, diag.message])

    return (
        <Details initiallyOpen data-vscode-context={JSON.stringify(context)}>
            <span className={severityClass}>
                {title}
                <span className="fr" onClick={e => e.preventDefault()}>
                    <a
                        className="link pointer mh2 dim codicon codicon-go-to-file"
                        onClick={_ => {
                            void ec.revealLocation(loc)
                        }}
                        title="Go to source location of message"
                    ></a>
                    {isMessageWithTraceSearch && (
                        <a
                            className={
                                'link pointer mh2 dim codicon ' +
                                (isSearchWidgetDisplayed ? 'codicon-search-stop' : 'codicon-go-to-search')
                            }
                            onClick={_ => {
                                if (isSearchWidgetDisplayed) {
                                    setSearchWidgetDisplayed(false)
                                    setTraceSearchMessage('')
                                    setMsg(diag.message)
                                } else {
                                    setSearchWidgetDisplayed(true)
                                }
                            }}
                            title={isSearchWidgetDisplayed ? 'Hide search' : 'Show search'}
                            data-id={isSearchWidgetDisplayed ? 'hide-trace-search' : 'show-trace-search'}
                        ></a>
                    )}
                </span>
            </span>
            <div className="ml1" ref={node}>
                <pre className="font-code pre-wrap">
                    <EnvPosContext.Provider value={startPos}>
                        {isSearchWidgetDisplayed && (
                            <form
                                onSubmit={e => {
                                    e.preventDefault()
                                    void search()
                                }}
                            >
                                <VscodeTextfield
                                    className="trace-search"
                                    value={traceSearchMessage}
                                    onInput={e => setTraceSearchMessage((e.target as HTMLInputElement).value)}
                                    placeholder="Search"
                                >
                                    <a
                                        className="link pointer mh2 dim codicon codicon-collapse-all"
                                        title="Collapse all"
                                        slot="content-after"
                                        onClick={_ => {
                                            setTraceSearchMessage('')
                                            setMsg(diag.message)
                                        }}
                                    ></a>
                                    <a
                                        className="link pointer mh2 dim codicon codicon-search"
                                        type="submit"
                                        title="Search"
                                        slot="content-after"
                                        onClick={_ => void search()}
                                    ></a>
                                </VscodeTextfield>
                            </form>
                        )}
                        <InteractiveMessage fmt={msg} />
                    </EnvPosContext.Provider>
                </pre>
            </div>
        </Details>
    )
}, fastIsEqual)

function comparePosition(p1: Position, p2: Position): number {
    const l = p1.line - p2.line
    if (l !== 0) {
        return l
    }
    return p1.character - p2.character
}

function compareRange(r1: Range, r2: Range): number {
    const s = comparePosition(r1.start, r2.start)
    if (s !== 0) {
        return s
    }
    return comparePosition(r1.end, r2.end)
}

type Proximity = { relation: 'Before' | 'After' | 'Inside'; lineDistance: number; characterOffset: number }

function computeProximity(r: Range, p: Position): Proximity {
    if (PositionHelpers.isLessThanOrEqual(r.end, p)) {
        return {
            relation: 'Before',
            lineDistance: p.line - r.end.line,
            characterOffset: r.end.character,
        }
    }
    if (PositionHelpers.isLessThan(p, r.start)) {
        return {
            relation: 'After',
            lineDistance: r.start.line - p.line,
            characterOffset: r.start.character,
        }
    }
    return {
        relation: 'Inside',
        lineDistance: p.line - r.start.line,
        characterOffset: r.start.character,
    }
}

function relationPriority(r: 'Before' | 'After' | 'Inside'): number {
    switch (r) {
        case 'Inside':
            return 0
        case 'Before':
            return 1
        case 'After':
            return 2
    }
}

function compareProximity(p1: Proximity, p2: Proximity): number {
    const ld = p1.lineDistance - p2.lineDistance
    if (ld !== 0) {
        return ld
    }
    const r = relationPriority(p1.relation) - relationPriority(p2.relation)
    if (r !== 0) {
        return r
    }
    const rel = p1.relation
    if (rel === 'Before' || rel === 'Inside') {
        return p2.characterOffset - p1.characterOffset
    }
    rel satisfies 'After'
    return p1.characterOffset - p2.characterOffset
}

function sortDiags(
    idiags: InteractiveDiagnostic[],
    sortOrder: MessageOrder,
    p: DocumentPosition | undefined,
): InteractiveDiagnostic[] {
    if (p === undefined || sortOrder === 'Sort by message location') {
        return idiags.toSorted((d1, d2) => compareRange(d1.fullRange ?? d1.range, d2.fullRange ?? d2.range))
    }
    sortOrder satisfies 'Sort by proximity to text cursor'
    return idiags.toSorted((d1, d2) => {
        const p1 = computeProximity(d1.range, p)
        const p2 = computeProximity(d2.range, p)
        return compareProximity(p1, p2)
    })
}

function mkMessageViewProps(
    uri: DocumentUri,
    messages: InteractiveDiagnostic[],
    sortOrder: MessageOrder,
    pos: DocumentPosition | undefined,
): Keyed<MessageViewProps>[] {
    const views: MessageViewProps[] = sortDiags(messages, sortOrder, pos).map(m => {
        return { uri, diag: m }
    })

    return addUniqueKeys(views, v => JSON.stringify(v))
}

/** Shows the given messages assuming they are for the given file. */
export const MessagesList = React.memo(
    ({
        uri,
        messages,
        sortOrder,
        pos,
    }: {
        uri: DocumentUri
        messages: InteractiveDiagnostic[]
        sortOrder: MessageOrder
        pos: DocumentPosition | undefined
    }) => {
        const should_hide = messages.length === 0
        if (should_hide) {
            return <>No messages.</>
        }

        return (
            <div className="ml1">
                {mkMessageViewProps(uri, messages, sortOrder, pos).map(m => (
                    <MessageView {...m} key={m.key} />
                ))}
            </div>
        )
    },
)

function lazy<T>(f: () => T): () => T {
    let state: { t: T } | undefined
    return () => {
        if (!state) state = { t: f() }
        return state.t
    }
}

interface InteractiveDiagBundle {
    diags: InteractiveDiagnostic[]
    tally: DiagnosticTally
}

/** Displays all messages for the specified file. Can be paused. */
export function AllMessages({ uri: uri0 }: { uri: DocumentUri }) {
    const ec = React.useContext(EditorContext)
    const rs0 = useRpcSessionAtPos({ uri: uri0, line: 0, character: 0 })
    const dc = React.useContext(LspDiagnosticsContext)
    const config = React.useContext(ConfigContext)
    const diags0 = React.useMemo(() => dc.get(uri0) || [], [dc, uri0]).filter(
        diag => diag.isSilent === undefined || !diag.isSilent,
    )

    const curPos: DocumentPosition | undefined = useEventResult(ec.events.changedCursorLocation, loc =>
        loc ? { uri: loc.uri, ...loc.range.start } : undefined,
    )

    const [sortOrder, setSortOrder] = React.useState<MessageOrder>(config.messageOrder)

    const iDiags0 = React.useMemo(
        () =>
            lazy(async () => {
                // The last line for which we have received diagnostics so far.
                // Providing a line range to `getInteractiveDiagnostics`
                // ensures that the call doesn't block until the whole file is elaborated.
                const maxLine = diags0.reduce((ln, d) => Math.max(ln, d.range.end.line), 0) + 1
                try {
                    let diags = await getInteractiveDiagnostics(rs0, { start: 0, end: maxLine })
                    diags = diags.filter(d => d.isSilent === undefined || !d.isSilent)
                    if (diags.length > 0) {
                        return { diags, tally: tallyOfDiags(diags) }
                    }
                } catch (err: any) {
                    if (err?.code === RpcErrorCode.ContentModified) {
                        // Document has been changed since we made the request. This can happen
                        // while typing quickly. When the server catches up on next edit, it will
                        // send new diagnostics to which the infoview responds by calling
                        // `getInteractiveDiagnostics` again.
                    } else {
                        console.log('getInteractiveDiagnostics error ', err)
                    }
                }
                const diags = diags0.map(d => ({ ...d, message: { text: d.message } }))
                return { diags, tally: tallyOfDiags(diags) }
            }),
        [rs0, diags0],
    )
    const [{ isPaused, setPaused }, [uri, rs, diags, iDiags], _] = usePausableState(false, [uri0, rs0, diags0, iDiags0])

    // Fetch interactive diagnostics when we're entering the paused state
    // (if they haven't already been fetched before)
    React.useEffect(() => {
        if (isPaused) {
            void iDiags()
        }
    }, [iDiags, isPaused])

    const setOpenRef = React.useRef<React.Dispatch<React.SetStateAction<boolean>>>()
    useEvent(
        ec.events.requestedAction,
        _ => {
            if (setOpenRef.current !== undefined) {
                setOpenRef.current(t => !t)
            }
        },
        [setOpenRef],
        'toggleAllMessages',
    )

    // The number of actually displayed messages, or `undefined` if the panel is collapsed.
    // When `undefined`, we can approximate it by `diags.length`.
    const [tally, setTally] = React.useState<DiagnosticTally | undefined>(undefined)

    const id = React.useId()
    useEvent(ec.events.clickedContextMenu, _ => setPaused(true), [], `pauseAllMessages:${id}`)
    useEvent(ec.events.clickedContextMenu, _ => setPaused(false), [], `unpauseAllMessages:${id}`)

    const context = isPaused ? { unpauseAllMessagesId: id } : { pauseAllMessagesId: id }

    return (
        <RpcContext.Provider value={rs}>
            <Details
                setOpenRef={r => (setOpenRef.current = r)}
                initiallyOpen={!config.autoOpenShowsGoal}
                data-vscode-context={JSON.stringify(context)}
            >
                <>
                    All Messages <TallyDisplay t={tally ?? tallyOfDiags(diags)}></TallyDisplay>
                    <span
                        className="fr"
                        onClick={e => {
                            e.preventDefault()
                        }}
                    >
                        <a
                            className={'link pointer mh2 dim codicon codicon-sort-precedence'}
                            onClick={_ => {
                                setSortOrder(o =>
                                    o === 'Sort by message location'
                                        ? 'Sort by proximity to text cursor'
                                        : 'Sort by message location',
                                )
                            }}
                            title={
                                sortOrder === 'Sort by message location'
                                    ? 'Sort by proximity to text cursor'
                                    : 'Sort by message location'
                            }
                        ></a>
                        <a
                            className={
                                'link pointer mh2 dim codicon ' +
                                (isPaused ? 'codicon-debug-continue' : 'codicon-debug-pause')
                            }
                            onClick={_ => {
                                setPaused(p => !p)
                            }}
                            title={isPaused ? "Unpause 'All Messages'" : "Pause 'All Messages'"}
                            data-id={isPaused ? 'unpause-all-messages' : 'pause-all-messages'}
                        ></a>
                    </span>
                </>
                <AllMessagesBody uri={uri} messages={iDiags} tally={tally} setTally={setTally} sortOrder={sortOrder} pos={curPos} />
            </Details>
        </RpcContext.Provider>
    )
}

export interface DiagnosticTally {
    errors: number
    warnings: number
    infos: number
    total: number
}

export function tallyOfDiags(msgs: { severity?: DiagnosticSeverity }[]): DiagnosticTally {
    return {
        errors: count(msgs, m => m.severity === DiagnosticSeverity.Error),
        warnings: count(msgs, m => m.severity === DiagnosticSeverity.Warning),
        infos: count(msgs, m => m.severity === DiagnosticSeverity.Information),
        total: msgs.length,
    }
}

export function TallyDisplay({ t }: { t: DiagnosticTally }) {
    if (t.errors === 0 && t.warnings === 0 && t.infos === 0) {
        return <></>
    }
    const warningSpace = t.errors > 0 ? <> </> : <></>
    const infoSpace = t.warnings > 0 || t.errors > 0 ? <> </> : <></>
    return (
        <>
            (
            {t.errors > 0 && (
                <>
                    <span className={'font-codicon codicon codicon-error'}></span> {t.errors}
                </>
            )}
            {t.warnings > 0 && (
                <>
                    {warningSpace}
                    <span className={'font-codicon codicon codicon-warning'}></span> {t.warnings}
                </>
            )}
            {t.infos > 0 && (
                <>
                    {infoSpace}
                    <span className={'font-codicon codicon codicon-info'}></span> {t.infos}
                </>
            )}
            )
        </>
    )
}

interface AllMessagesBodyProps {
    uri: DocumentUri
    messages: () => Promise<InteractiveDiagBundle>
    tally: DiagnosticTally | undefined
    setTally: React.Dispatch<React.SetStateAction<DiagnosticTally | undefined>>
    sortOrder: MessageOrder
    pos: DocumentPosition | undefined
}

/** We factor out the body of {@link AllMessages} which lazily fetches its contents only when expanded. */
function AllMessagesBody({ uri, messages, tally, setTally, sortOrder, pos }: AllMessagesBodyProps) {
    const [msgs, setMsgs] = React.useState<InteractiveDiagnostic[] | undefined>(undefined)
    React.useEffect(() => {
        const fn = async () => {
            const { diags, tally: newTally } = await messages()
            setMsgs(diags)
            // Avoid re-render loop with `AllMessages`
            if (JSON.stringify(tally) !== JSON.stringify(newTally)) {
                setTally(newTally)
            }
        }
        void fn()
    }, [messages, tally, setTally])
    React.useEffect(() => () => /* Called on unmount. */ setTally(undefined), [setTally])
    if (msgs === undefined) return <>Loading messages...</>
    else return <MessagesList uri={uri} messages={msgs} sortOrder={sortOrder} pos={pos} />
}

/**
 * Provides a `LspDiagnosticsContext` which stores the latest version of the
 * diagnostics as sent by the publishDiagnostics notification.
 */
export function WithLspDiagnosticsContext({ children }: React.PropsWithChildren<{}>) {
    const [allDiags, _0] = useServerNotificationState(
        'textDocument/publishDiagnostics',
        new Map<DocumentUri, LeanDiagnostic[]>(),
        async (params: LeanPublishDiagnosticsParams) => diags => new Map(diags).set(params.uri, params.diagnostics),
        [],
    )

    return <LspDiagnosticsContext.Provider value={allDiags}>{children}</LspDiagnosticsContext.Provider>
}

/** Embeds a non-interactive diagnostic into the type `InteractiveDiagnostic`. */
export function lspDiagToInteractive(diag: Diagnostic): InteractiveDiagnostic {
    return { ...(diag as LeanDiagnostic), message: { text: diag.message } }
}
