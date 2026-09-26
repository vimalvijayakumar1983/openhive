import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type ConnectionEvent = {
  event_id: string
  call_id: string
  event_type: string
  participant_identity: string | null
  participant_sid: string | null
  track_source: string | null
  occurred_at: string
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspaceId')
  const page = Number(request.nextUrl.searchParams.get('page') || '0')
  if (!workspaceId || !Number.isInteger(page) || page < 0 || page > 1000) {
    return NextResponse.json({ error: 'Invalid workspace or page' }, { status: 400 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user }, error: authError } = await auth.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: membership, error: membershipError } = await admin
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('profile_id', user.id)
    .maybeSingle()

  if (membershipError) return NextResponse.json({ error: 'Membership lookup failed' }, { status: 500 })
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const pageSize = 20
  const { data: calls, error: callsError } = await admin
    .from('active_calls')
    .select('id, channel_id, type, livekit_room_name, started_by, started_at, ended_at')
    .eq('workspace_id', workspaceId)
    .order('started_at', { ascending: false })
    .range(page * pageSize, (page + 1) * pageSize)

  if (callsError) return NextResponse.json({ error: 'Call lookup failed' }, { status: 500 })
  if (!calls?.length) return NextResponse.json({ calls: [], hasMore: false })

  const callIds = calls.map(call => call.id)
  const channelIds = [...new Set(calls.map(call => call.channel_id))]
  const [eventsResult, channelsResult, participantsResult] = await Promise.all([
    admin.from('call_connection_events')
      .select('event_id, call_id, event_type, participant_identity, participant_sid, track_source, occurred_at')
      .in('call_id', callIds)
      .order('occurred_at', { ascending: true })
      .limit(10000),
    admin.from('channels').select('id, name').in('id', channelIds),
    admin.from('call_participants').select('call_id, profile_id').in('call_id', callIds),
  ])
  if (eventsResult.error || channelsResult.error || participantsResult.error) {
    return NextResponse.json({ error: 'Call detail lookup failed' }, { status: 500 })
  }

  const events = (eventsResult.data || []) as ConnectionEvent[]
  const profileIds = [...new Set([
    ...calls.map(call => call.started_by),
    ...(participantsResult.data || []).map(p => p.profile_id),
    ...events.map(e => e.participant_identity).filter((id): id is string => !!id && /^[0-9a-f-]{36}$/i.test(id)),
  ])]
  const { data: profiles, error: profilesError } = await admin
    .from('profiles').select('id, display_name').in('id', profileIds)
  if (profilesError) return NextResponse.json({ error: 'Profile lookup failed' }, { status: 500 })

  const names = new Map((profiles || []).map(p => [p.id, p.display_name]))
  const channels = new Map((channelsResult.data || []).map(c => [c.id, c.name]))
  const nowMs = Date.now()

  const rows = calls.map(call => {
    const callEvents = events.filter(e => e.call_id === call.id)
    const roomFinished = callEvents.find(e => e.event_type === 'room_finished')
    const endMs = roomFinished ? Date.parse(roomFinished.occurred_at) : call.ended_at ? Date.parse(call.ended_at) : nowMs
    const joinEvents = callEvents.filter(e => e.event_type === 'participant_joined' && e.participant_sid)
    const leaveBySid = new Map(callEvents
      .filter(e => e.event_type === 'participant_left' && e.participant_sid)
      .map(e => [e.participant_sid, e]))
    let participantSeconds = 0
    const connections = joinEvents.map(join => {
      const leave = leaveBySid.get(join.participant_sid!)
      const leftAt = leave?.occurred_at || (roomFinished?.occurred_at || null)
      const stopMs = Math.min(endMs, leftAt ? Date.parse(leftAt) : endMs)
      const seconds = Math.max(0, (stopMs - Date.parse(join.occurred_at)) / 1000)
      participantSeconds += seconds
      return {
        identity: join.participant_identity,
        name: names.get(join.participant_identity || '') || 'Unknown user',
        joinedAt: join.occurred_at,
        leftAt,
        seconds: Math.round(seconds),
      }
    })
    const profileIdsForCall = [...new Set([
      ...(participantsResult.data || []).filter(p => p.call_id === call.id).map(p => p.profile_id),
      ...connections.map(c => c.identity).filter((id): id is string => !!id),
    ])]
    const videoUsed = callEvents.some(e => e.event_type === 'track_published' &&
      (e.track_source === 'camera' || e.track_source === 'screen_share'))

    return {
      id: call.id,
      channelName: channels.get(call.channel_id) || 'Deleted channel',
      startedBy: names.get(call.started_by) || 'Unknown user',
      startedAt: call.started_at,
      endedAt: roomFinished?.occurred_at || call.ended_at,
      durationSeconds: Math.max(0, Math.round((endMs - Date.parse(call.started_at)) / 1000)),
      participantNames: profileIdsForCall.map(id => names.get(id) || 'Unknown user'),
      participantSeconds: Math.round(participantSeconds),
      connections,
      videoUsed,
      verifiedByLiveKit: joinEvents.length > 0,
      // This is only the connection component at Ship overage rates. Monthly
      // allowances and billable bandwidth are unavailable on the Build plan.
      connectionEstimateUsd: joinEvents.length ? Number((participantSeconds / 60 * 0.0005).toFixed(6)) : null,
    }
  })

  return NextResponse.json({ calls: rows.slice(0, pageSize), hasMore: calls.length > pageSize })
}
