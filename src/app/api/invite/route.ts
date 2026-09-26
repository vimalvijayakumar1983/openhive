import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addInvitedMember } from '@/lib/invite-membership'

export async function POST(request: NextRequest) {
  try {
    const { email, workspaceId, workspaceName } = await request.json()

    if (!email || !workspaceId) {
      return NextResponse.json({ error: 'Missing email or workspaceId' }, { status: 400 })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRoleKey || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Service role key not configured. Add it in workspace settings.' },
        { status: 400 }
      )
    }

    // SECURITY: Verify caller is authenticated and is admin/owner of the workspace
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    }

    // Create admin client with service_role key
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Check that caller is admin/owner of the target workspace
    const { data: membership } = await supabaseAdmin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', user.id)
      .single()

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return NextResponse.json({ error: 'Only admins can invite members' }, { status: 403 })
    }

    // Check if user already exists
    let existingUser: Awaited<ReturnType<typeof supabaseAdmin.auth.admin.listUsers>>['data']['users'][number] | undefined
    for (let page = 1; !existingUser; page++) {
      const { data: existingUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 })
      if (listError) throw listError
      existingUser = existingUsers.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
      if (existingUsers.users.length < 1000) break
    }

    if (existingUser) {
      // User exists — add them to workspace directly
      // Check if already a member
      const { data: existing } = await supabaseAdmin
        .from('workspace_members')
        .select('profile_id')
        .eq('workspace_id', workspaceId)
        .eq('profile_id', existingUser.id)
        .limit(1)

      if (existing && existing.length > 0) {
        return NextResponse.json({ error: 'This person is already a member', alreadyMember: true }, { status: 400 })
      }

      const displayName = existingUser.user_metadata?.display_name || email
      await addInvitedMember(supabaseAdmin, workspaceId, existingUser.id, email, displayName)
      const { error: metadataError } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        user_metadata: {
          ...existingUser.user_metadata,
          workspace_id: workspaceId,
          workspace_name: workspaceName || 'OpenHive',
          openhive_onboarding_complete: true,
        },
      })
      if (metadataError) throw metadataError
      return NextResponse.json({ success: true, added: true, displayName })
    }

    // User doesn't exist — send invite email via Supabase Auth
    const redirectTo = `${request.nextUrl.origin}/auth?workspace=${workspaceId}&email=${encodeURIComponent(email)}`

    const { data: invitation, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        workspace_id: workspaceId,
        workspace_name: workspaceName || 'OpenHive',
        display_name: email.split('@')[0],
      },
    })

    if (error) {
      // Handle "already invited" case
      if (error.message?.includes('already been registered') || error.message?.includes('already exists')) {
        return NextResponse.json({
          error: 'This email has already been invited. They should check their inbox.',
          alreadyInvited: true,
        }, { status: 400 })
      }
      throw error
    }

    if (!invitation.user) throw new Error('Invitation did not return a user')
    await addInvitedMember(supabaseAdmin, workspaceId, invitation.user.id, email, email.split('@')[0])

    return NextResponse.json({
      success: true,
      invited: true,
      message: `Invitation email sent to ${email}`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to send invite' },
      { status: 500 }
    )
  }
}
