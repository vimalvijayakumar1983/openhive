export function resolveWorkspaceMembership<T extends { workspace_id: string }>(
  members: T[] | null,
  invitedWorkspaceId?: string,
  preferredWorkspaceId?: string | null,
  seenInviteWorkspaceId?: string | null
): { kind: 'member'; member: T; newInvite: boolean } | { kind: 'invite-missing' } | { kind: 'new-user' } {
  const newInvite = !!invitedWorkspaceId && invitedWorkspaceId !== seenInviteWorkspaceId
  if (newInvite) {
    const invitedMembership = members?.find((member) => member.workspace_id === invitedWorkspaceId)
    return invitedMembership
      ? { kind: 'member', member: invitedMembership, newInvite: true }
      : { kind: 'invite-missing' }
  }

  const preferred = members?.find((member) => member.workspace_id === preferredWorkspaceId)
  const member = preferred || members?.[0]
  if (member) return { kind: 'member', member, newInvite: false }
  return invitedWorkspaceId ? { kind: 'invite-missing' } : { kind: 'new-user' }
}
