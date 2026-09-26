'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, ChevronDown, ChevronUp, Video, Headphones } from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'

type Connection = {
  identity: string | null
  name: string
  joinedAt: string
  leftAt: string | null
  seconds: number
}

type CallLog = {
  id: string
  channelName: string
  startedBy: string
  startedAt: string
  endedAt: string | null
  durationSeconds: number
  participantNames: string[]
  participantSeconds: number
  connections: Connection[]
  videoUsed: boolean
  verifiedByLiveKit: boolean
  connectionEstimateUsd: number | null
}

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = Math.floor(seconds % 60)
  return hours ? `${hours}h ${minutes}m ${remainder}s` : `${minutes}m ${remainder}s`
}

function dateTime(value: string) {
  return new Date(value).toLocaleString()
}

export function CallLogs() {
  const workspace = useAppStore(state => state.workspace)
  const [calls, setCalls] = useState<CallLog[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    setError(null)
    try {
      const client = getSupabaseClient()
      const session = (await client?.auth.getSession())?.data.session
      if (!session) throw new Error('Please sign in again')
      const response = await fetch(`/api/admin/call-logs?workspaceId=${encodeURIComponent(workspace.id)}&page=${page}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load call logs')
      setCalls(result.calls)
      setHasMore(result.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load call logs')
    } finally {
      setLoading(false)
    }
  }, [workspace, page])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
        <strong>Actual per-call charge is unavailable on this LiveKit plan.</strong> LiveKit webhooks give us
        observed connection time, but per-call billable bandwidth requires the Scale Analytics API.
        The estimate below applies the Ship overage rate of $0.0005 per participant-minute to
        observed time. It excludes monthly allowances, bandwidth, and the plan fee.
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Newest calls first · times in your local timezone</span>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 text-xs text-[#7C5CFC] hover:underline disabled:opacity-50">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {loading && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
      {!loading && !error && calls.length === 0 && (
        <p className="rounded-lg border p-6 text-center text-muted-foreground">No calls recorded yet.</p>
      )}

      {!loading && !error && calls.map(call => {
        const expanded = expandedId === call.id
        return (
          <div key={call.id} className="rounded-lg border border-[#E5E1EE] bg-white">
            <button onClick={() => setExpandedId(expanded ? null : call.id)} className="w-full p-3 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-semibold text-[#2D2B3D]">
                    {call.videoUsed ? <Video className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
                    <span className="truncate">#{call.channelName}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{dateTime(call.startedAt)} · Started by {call.startedBy}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {call.endedAt ? duration(call.durationSeconds) : 'In progress'} · {call.participantNames.length} participant{call.participantNames.length === 1 ? '' : 's'}
                  </div>
                </div>
                {expanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
              </div>
              <div className="mt-2 text-xs font-medium text-[#4A4860]">
                {call.verifiedByLiveKit
                  ? `${duration(call.participantSeconds)} observed participant time · $${call.connectionEstimateUsd?.toFixed(4)} connection estimate`
                  : 'LiveKit connection data not recorded for this call'}
              </div>
            </button>

            {expanded && <div className="space-y-2 border-t border-[#E5E1EE] p-3 text-xs">
              <div><strong>Participants:</strong> {call.participantNames.join(', ') || 'None recorded'}</div>
              <div><strong>Ended:</strong> {call.endedAt ? dateTime(call.endedAt) : 'Still active'}</div>
              <div><strong>Media:</strong> {call.videoUsed ? 'Video or screen share used' : 'Audio only or no video event recorded'}</div>
              <div><strong>Actual LiveKit charge:</strong> Unavailable on current plan</div>
              <div><strong>Call ID:</strong> <span className="font-mono break-all">{call.id}</span></div>
              {call.connections.length > 0 && <div className="space-y-1 pt-1">
                <strong>Verified connections</strong>
                {call.connections.map((connection, index) => <div key={`${connection.identity}-${connection.joinedAt}-${index}`} className="flex justify-between gap-2 rounded bg-[#F5F2FF] px-2 py-1">
                  <span>{connection.name} · {dateTime(connection.joinedAt)}{connection.leftAt ? ` → ${dateTime(connection.leftAt)}` : ' → connected'}</span>
                  <span className="shrink-0">{duration(connection.seconds)}</span>
                </div>)}
              </div>}
            </div>}
          </div>
        )
      })}

      {!loading && !error && (page > 0 || hasMore) && <div className="flex justify-between pt-1">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="text-xs text-[#7C5CFC] disabled:opacity-40">Previous</button>
        <span className="text-xs text-muted-foreground">Page {page + 1}</span>
        <button disabled={!hasMore} onClick={() => setPage(p => p + 1)} className="text-xs text-[#7C5CFC] disabled:opacity-40">Next</button>
      </div>}
    </div>
  )
}
