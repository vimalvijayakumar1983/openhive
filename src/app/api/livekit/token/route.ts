import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { AccessToken } from 'livekit-server-sdk'

export async function POST(request: NextRequest) {
  try {
    const { roomName, workspaceId, identity, displayName } = await request.json()

    if (!roomName || !workspaceId || !identity || !displayName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Server-managed credentials belong to this deployment's workspace.
    // Fail closed in production if the workspace has not been configured.
    const allowedWorkspaceId = process.env.LIVEKIT_ALLOWED_WORKSPACE_ID
    if (process.env.NODE_ENV === 'production' && !allowedWorkspaceId) {
      return NextResponse.json({ error: 'LiveKit workspace not configured' }, { status: 503 })
    }
    if (allowedWorkspaceId && workspaceId !== allowedWorkspaceId) {
      return NextResponse.json({ error: 'Calls are unavailable for this workspace' }, { status: 403 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
    }

    // Use the user's auth token to verify identity
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    })

    // Verify user session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    }

    // Look up workspace settings for LiveKit credentials
    const { data: settings, error: settingsError } = await supabase
      .from('workspace_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .single()

    if (settingsError || !settings) {
      return NextResponse.json(
        { error: 'LiveKit not configured. Set up LiveKit in workspace settings.' },
        { status: 400 }
      )
    }

    if (!settings.calls_enabled) {
      return NextResponse.json({ error: 'Calls are disabled for this workspace' }, { status: 400 })
    }

    // Only issue a token for a live call in a channel this user has joined.
    const { data: activeCall } = await supabase
      .from('active_calls')
      .select('channel_id')
      .eq('workspace_id', workspaceId)
      .eq('livekit_room_name', roomName)
      .is('ended_at', null)
      .single()

    if (!activeCall) {
      return NextResponse.json({ error: 'Call not found' }, { status: 403 })
    }

    const { data: channelMembership } = await supabase
      .from('channel_members')
      .select('channel_id')
      .eq('channel_id', activeCall.channel_id)
      .eq('profile_id', user.id)
      .single()

    if (!channelMembership) {
      return NextResponse.json({ error: 'Not a member of this channel' }, { status: 403 })
    }

    // Prefer server-managed credentials so the secret never needs to be stored
    // in workspace_settings, which workspace members can read.
    const serverManagedLiveKit = Boolean(
      process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
    )
    const livekitUrl = serverManagedLiveKit ? process.env.LIVEKIT_URL : settings.livekit_url
    const livekitApiKey = serverManagedLiveKit ? process.env.LIVEKIT_API_KEY : settings.livekit_api_key
    const livekitApiSecret = serverManagedLiveKit ? process.env.LIVEKIT_API_SECRET : settings.livekit_api_secret

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      return NextResponse.json(
        { error: 'LiveKit credentials not configured. Add them in workspace settings.' },
        { status: 400 }
      )
    }

    // SECURITY: Use verified user.id as identity (not client-supplied value)
    // This prevents identity spoofing — the client can suggest a displayName
    // but the identity is always the authenticated user's ID
    const token = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: user.id,
      name: displayName,
    })

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    })

    const jwt = await token.toJwt()

    return NextResponse.json({
      token: jwt,
      url: livekitUrl,
    })
  } catch (error) {
    console.error('LiveKit token error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate token' },
      { status: 500 }
    )
  }
}
