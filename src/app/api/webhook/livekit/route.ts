import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { WebhookReceiver } from 'livekit-server-sdk'

export const runtime = 'nodejs'

const trackedEvents = new Set([
  'participant_joined',
  'participant_left',
  'track_published',
  'track_unpublished',
  'room_finished',
])

function trackSource(source: number | undefined): string | null {
  switch (source) {
    case 1: return 'camera'
    case 2: return 'microphone'
    case 3: return 'screen_share'
    case 4: return 'screen_share_audio'
    default: return null
  }
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  const allowedWorkspaceId = process.env.LIVEKIT_ALLOWED_WORKSPACE_ID

  if (!apiKey || !apiSecret || !supabaseUrl || !serviceKey || !allowedWorkspaceId) {
    return NextResponse.json({ error: 'Webhook is not configured' }, { status: 503 })
  }

  let event
  try {
    // LiveKit signs the exact body bytes; parsing and re-stringifying breaks verification.
    event = await new WebhookReceiver(apiKey, apiSecret).receive(
      await request.text(),
      request.headers.get('authorization') || undefined
    )
  } catch {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

  if (!trackedEvents.has(event.event) || !event.room?.name || !event.id) {
    return NextResponse.json({ ok: true })
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: call, error: lookupError } = await admin
    .from('active_calls')
    .select('id')
    .eq('workspace_id', allowedWorkspaceId)
    .eq('livekit_room_name', event.room.name)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lookupError) {
    console.error('LiveKit webhook call lookup failed:', lookupError.message)
    return NextResponse.json({ error: 'Call lookup failed' }, { status: 500 })
  }
  if (!call) return NextResponse.json({ ok: true })

  const occurredAt = new Date(Number(event.createdAt) * 1000).toISOString()
  const { error: insertError } = await admin.from('call_connection_events').upsert({
    event_id: event.id,
    call_id: call.id,
    event_type: event.event,
    participant_identity: event.participant?.identity || null,
    participant_sid: event.participant?.sid || null,
    track_source: trackSource(event.track?.source),
    occurred_at: occurredAt,
  }, { onConflict: 'event_id', ignoreDuplicates: true })

  if (insertError) {
    console.error('LiveKit webhook event insert failed:', insertError.message)
    return NextResponse.json({ error: 'Event insert failed' }, { status: 500 })
  }

  if (event.event === 'room_finished') {
    const { error: updateError } = await admin.from('active_calls')
      .update({ ended_at: occurredAt })
      .eq('id', call.id)
      .is('ended_at', null)
    if (updateError) {
      console.error('LiveKit webhook call end failed:', updateError.message)
      return NextResponse.json({ error: 'Call end update failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true })
}
