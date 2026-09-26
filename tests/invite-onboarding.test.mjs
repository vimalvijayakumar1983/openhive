import assert from 'node:assert/strict'
import test from 'node:test'
import { addInvitedMember } from '../src/lib/invite-membership.ts'
import { resolveWorkspaceMembership } from '../src/lib/workspace-onboarding.ts'

function fakeAdmin(failTable) {
  const writes = []
  const admin = {
    from(table) {
      return {
        async upsert(rows) {
          writes.push({ table, rows })
          return { error: table === failTable ? new Error(`${table} failed`) : null }
        },
        select() { return this },
        eq() { return this },
        then(resolve) { resolve({ data: [{ id: 'general' }], error: null }) },
      }
    },
  }
  return { admin, writes }
}

test('email invitation attaches the invited account and public channels before acceptance', async () => {
  const { admin, writes } = fakeAdmin()
  await addInvitedMember(admin, 'inviter-workspace', 'invitee', 'prateek@example.com', 'Prateek')

  assert.deepEqual(writes.map(({ table }) => table), ['profiles', 'workspace_members', 'channel_members'])
  assert.deepEqual(writes[1].rows, {
    workspace_id: 'inviter-workspace', profile_id: 'invitee', role: 'member',
  })
  assert.deepEqual(writes[2].rows, [{ channel_id: 'general', profile_id: 'invitee' }])
})

test('failed membership insert rejects the invitation instead of reporting success', async () => {
  const { admin, writes } = fakeAdmin('workspace_members')
  await assert.rejects(
    addInvitedMember(admin, 'inviter-workspace', 'invitee', 'prateek@example.com', 'Prateek'),
    /workspace_members failed/
  )
  assert.equal(writes.some(({ table }) => table === 'channel_members'), false)
})

test('invited users enter the inviter workspace even when they have another membership', () => {
  const own = { workspace_id: 'own-workspace' }
  const invited = { workspace_id: 'inviter-workspace' }
  assert.deepEqual(resolveWorkspaceMembership([own, invited], 'inviter-workspace', 'own-workspace'), {
    kind: 'member', member: invited, newInvite: true,
  })
})

test('an unmatched invitation never opens workspace creation', () => {
  assert.deepEqual(resolveWorkspaceMembership([], 'inviter-workspace'), { kind: 'invite-missing' })
  assert.deepEqual(resolveWorkspaceMembership([{ workspace_id: 'own-workspace' }], 'inviter-workspace'), { kind: 'invite-missing' })
})

test('after the invite is seen, a deliberate workspace switch is retained', () => {
  const own = { workspace_id: 'own-workspace' }
  const invited = { workspace_id: 'inviter-workspace' }
  assert.deepEqual(resolveWorkspaceMembership([invited, own], 'inviter-workspace', 'own-workspace', 'inviter-workspace'), {
    kind: 'member', member: own, newInvite: false,
  })
})

test('only an uninvited user with no membership creates a workspace', () => {
  assert.deepEqual(resolveWorkspaceMembership([], undefined), { kind: 'new-user' })
})
