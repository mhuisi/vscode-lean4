/**
 * Traces of any substantial compilation or elaboration process are usually extremely verbose,
 * which makes them slow (or even infeasible) to pretty-print and difficult to understand.
 * Instead, we provide a "TraceExplorer" UI which allows users to lazily expand trace subtrees,
 * and (TODO) execute search queries.
 *
 * @module
 */

import { HighlightedMsgEmbed, HighlightedTraceEmbed, lazyTraceChildrenToInteractive } from '@leanprover/infoview-api'
import * as React from 'react'
import { Goal } from './goals'
import {
    InteractiveCode,
    InteractiveTaggedText,
    InteractiveTagProps,
    InteractiveTextComponentProps,
} from './interactiveCode'
import { useRpcSession } from './rpcSessions'
import { DynamicComponent } from './userWidget'
import { mapRpcError, useAsyncWithTrigger } from './util'

const TraceClassContext = React.createContext<string>('')

function abbreviateCommonPrefix(parent: string, cls: string): string {
    const parentParts = parent.split('.')
    const clsParts = cls.split('.')
    let i = 0
    for (; i < parentParts.length && i < clsParts.length && parentParts[i] === clsParts[i]; i++);
    return clsParts.slice(i).join('.')
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
function TraceLine({ indent, cls, msg, icon }: HighlightedTraceEmbed & { icon: string }) {
    const spaces = ' '.repeat(indent)
    const abbrCls = abbreviateCommonPrefix(React.useContext(TraceClassContext), cls)
    return (
        <div className="trace-line">
            {spaces}
            <span className="trace-class" title={cls}>
                [{abbrCls}]
            </span>{' '}
            <InteractiveMessage fmt={msg} /> {icon}
        </div>
    )
}

function ChildlessTraceNode(traceEmbed: HighlightedTraceEmbed) {
    return <TraceLine {...traceEmbed} icon="" />
}

function CollapsibleTraceNode(traceEmbed: HighlightedTraceEmbed) {
    const { cls, collapsed: collapsedByDefault, children: lazyKids } = traceEmbed

    const rs = useRpcSession()
    const [children, fetchChildren] = useAsyncWithTrigger(async () => {
        if ('strict' in lazyKids) {
            return lazyKids.strict
        } else {
            return lazyTraceChildrenToInteractive(rs, lazyKids.lazy)
        }
    }, [rs, lazyKids])

    const [open, setOpen] = React.useState(!collapsedByDefault) // TODO: reset when collapsedByDefault changes?
    if (open && children.state === 'notStarted') void fetchChildren()
    let icon = open ? '▼' : '▶'
    if (children.state === 'loading') icon += ' ⋯'

    const onClick = React.useCallback(
        (ev: React.MouseEvent) => {
            if (!(ev.target instanceof Node)) return
            if (!ev.currentTarget || !ev.target) return
            // Don't handle clicks within React portals nested in this div (notably, tooltips).
            if (!ev.currentTarget.contains(ev.target)) return
            ev.stopPropagation()
            ev.preventDefault()
            if (!open) void fetchChildren()
            setOpen(o => !o)
        },
        [open, fetchChildren],
    )

    return (
        <div>
            <div className="pointer" onClick={onClick}>
                <TraceLine {...traceEmbed} icon={icon} />
            </div>
            <div style={{ display: open ? 'block' : 'none' }}>
                <TraceClassContext.Provider value={cls}>
                    {children.state === 'resolved' ? (
                        children.value.map((tt, i) => <InteractiveMessage fmt={tt} key={i} />)
                    ) : children.state === 'rejected' ? (
                        mapRpcError(children.error).toString()
                    ) : (
                        <></>
                    )}
                </TraceClassContext.Provider>
            </div>
        </div>
    )
}

function Trace(traceEmbed: HighlightedTraceEmbed) {
    const noChildren = 'strict' in traceEmbed.children && traceEmbed.children.strict.length === 0
    return noChildren ? <ChildlessTraceNode {...traceEmbed} /> : <CollapsibleTraceNode {...traceEmbed} />
}

function InteractiveMessageTag({ tag: embed }: InteractiveTagProps<HighlightedMsgEmbed>): JSX.Element {
    if (embed === 'highlighted') {
        return <span className="highlighted-text"></span>
    }
    if ('expr' in embed) return <InteractiveCode fmt={embed.expr} />
    else if ('goal' in embed)
        return (
            <Goal
                goal={embed.goal}
                settings={{
                    reverse: false,
                    hideGoalNames: false,
                    emphasizeFirstGoal: false,
                    showType: true,
                    showInstance: true,
                    showHiddenAssumption: true,
                    showLetValue: true,
                }}
                additionalClassNames=""
            />
        )
    else if ('widget' in embed)
        return <DynamicComponent hash={embed.widget.wi.javascriptHash} props={embed.widget.wi.props} />
    else if ('trace' in embed) return <Trace {...embed.trace} />
    else return <div>malformed MsgEmbed: {JSON.stringify(embed)}</div>
}

export function InteractiveMessage({ fmt }: InteractiveTextComponentProps<HighlightedMsgEmbed>) {
    return InteractiveTaggedText({ fmt, InnerTagUi: InteractiveMessageTag })
}
