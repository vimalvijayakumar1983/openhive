import type { SupabaseClient } from '@supabase/supabase-js'

export async function addInvitedMember(
  admin: SupabaseClient,
  workspaceId: string,
  userId: string,
  email: string,
  displayName: string
) {
  // The workspace admin authorized this invitation. Persist membership before
  // the invitee follows the email link; auth redirects may drop query params.
  const { error: profileError } = await admin.from('profiles').upsert({
    id: userId,
    email,
    display_name: displayName,
  }, { onConflict: 'id', ignoreDuplicates: true })
  if (profileError) throw profileError

  const { error: memberError } = await admin.from('workspace_members').upsert({
    workspace_id: workspaceId,
    profile_id: userId,
    role: 'member',
  }, { onConflict: 'workspace_id,profile_id', ignoreDuplicates: true })
  if (memberError) throw memberError

  const { data: channels, error: channelsError } = await admin
    .from('channels')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('is_private', false)
  if (channelsError) throw channelsError

  if (channels?.length) {
    const { error: channelMemberError } = await admin
      .from('channel_members')
      .upsert(channels.map((channel) => ({
        channel_id: channel.id,
        profile_id: userId,
      })), { onConflict: 'channel_id,profile_id', ignoreDuplicates: true })
    if (channelMemberError) throw channelMemberError
  }
}
