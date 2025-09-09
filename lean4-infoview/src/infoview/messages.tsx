import * as React from 'react'
import fastIsEqual from 'react-fast-compare'
import { Diagnostic, DiagnosticSeverity, DocumentUri, Location, Position, Range } from 'vscode-languageserver-protocol'

import {
    highlightMatches,
    LeanDiagnostic,
    LeanPublishDiagnosticsParams,
    MessageOrder,
    MsgEmbed,
    RpcErrorCode,
    TaggedText,
} from '@leanprover/infoview-api'

import { getInteractiveDiagnostics, InteractiveDiagnostic } from '@leanprover/infoview-api'
import { Details } from './collapsing'
import { ConfigContext, EditorContext, EnvPosContext, LspDiagnosticsContext } from './contexts'
import { RpcContext, useRpcSession, useRpcSessionAtPos } from './rpcSessions'
import { InteractiveMessage } from './traceExplorer'
import {
    addUniqueKeys,
    basename,
    DocumentPosition,
    escapeHtml,
    Keyed,
    PositionHelpers,
    useAsyncWithTrigger,
    useEvent,
    useEventResult,
    usePausableState,
    useServerNotificationState,
} from './util'

interface MessageViewProps {
    uri: DocumentUri
    diag: InteractiveDiagnostic
}

function isTraceMessage(message: TaggedText<MsgEmbed>): boolean {
    if (!('tag' in message)) {
        return false
    }
    const embed = message.tag[0]
    if (!('trace' in embed)) {
        return false
    }
    return true
}

const MessageView = React.memo(({ uri, diag }: MessageViewProps) => {
    const rs = useRpcSession()
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

    const messageId = React.useId()
    useEvent(
        ec.events.clickedContextMenu,
        async _ => void ec.revealLocation(loc),
        [loc],
        `goToMessageLocation:${messageId}`,
    )
    useEvent(
        ec.events.clickedContextMenu,
        async _ => {
            if (node.current) {
                void ec.api.copyToClipboard(node.current.innerText)
            }
        },
        [loc],
        `copyMessage:${messageId}`,
    )

    const [traceSearchMessage, setTraceSearchMessage] = React.useState('')

    const [highlightedMsg, search] = useAsyncWithTrigger(async () => {
        if (traceSearchMessage === '') {
            // TODO: this resets the collapse state, which we might not want.
            return diag.message
        }
        return await highlightMatches(rs, traceSearchMessage, diag.message)
    }, [])
    const msg = highlightedMsg.state === 'resolved' ? highlightedMsg.value : diag.message

    return (
        <Details
            initiallyOpen
            data-vscode-context={JSON.stringify({ goToMessageLocationId: messageId, copyMessageId: messageId })}
        >
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
                    {isTraceMessage(msg) && (
                        <>
                            <input
                                name="traceSearch"
                                value={traceSearchMessage}
                                onChange={e => setTraceSearchMessage(e.target.value)}
                            ></input>
                            <a
                                className="link pointer mh2 dim codicon codicon-search"
                                title="Search"
                                onClick={_ => {
                                    void search()
                                }}
                            ></a>
                        </>
                    )}
                </span>
            </span>
            <div className="ml1" ref={node}>
                <pre className="font-code pre-wrap">
                    <EnvPosContext.Provider value={startPos}>
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

    return addUniqueKeys(views, v => DocumentPosition.toString({ uri: v.uri, ...v.diag.range.start }))
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
                        return diags
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
                return diags0.map(d => ({ ...d, message: { text: d.message } }))
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
    const [numDiags, setNumDiags] = React.useState<number | undefined>(undefined)

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
                    All Messages ({numDiags ?? diags.length})
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
                        ></a>
                    </span>
                </>
                <AllMessagesBody
                    uri={uri}
                    messages={iDiags}
                    setNumDiags={setNumDiags}
                    sortOrder={sortOrder}
                    pos={curPos}
                />
            </Details>
        </RpcContext.Provider>
    )
}

interface AllMessagesBodyProps {
    uri: DocumentUri
    messages: () => Promise<InteractiveDiagnostic[]>
    setNumDiags: React.Dispatch<React.SetStateAction<number | undefined>>
    sortOrder: MessageOrder
    pos: DocumentPosition | undefined
}

/** We factor out the body of {@link AllMessages} which lazily fetches its contents only when expanded. */
function AllMessagesBody({ uri, messages, setNumDiags, sortOrder, pos }: AllMessagesBodyProps) {
    const [msgs, setMsgs] = React.useState<InteractiveDiagnostic[] | undefined>(undefined)
    React.useEffect(() => {
        const fn = async () => {
            const msgs = await messages()
            setMsgs(msgs)
            setNumDiags(msgs.length)
        }
        void fn()
    }, [messages, setNumDiags])
    React.useEffect(() => () => /* Called on unmount. */ setNumDiags(undefined), [setNumDiags])
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
