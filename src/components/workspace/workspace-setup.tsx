'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Building2, Loader2 } from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'
import type { Workspace, Channel } from '@/types/database'

interface WorkspaceSetupProps {
  onCreated: (workspace: Workspace) => void
}

export function WorkspaceSetup({ onCreated }: WorkspaceSetupProps) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const client = getSupabaseClient()
    if (!client || !name.trim()) return

    setLoading(true)
    setError(null)

    try {
      const { data: { session } } = await client.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const slug = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')

      // The workspace and owner membership must be created atomically: the
      // workspace INSERT policy cannot see a membership before the row exists.
      const { data: workspaceId, error: wsError } = await client.rpc('create_workspace_with_owner', {
        p_name: name.trim(),
        p_slug: slug,
      })

      if (wsError) throw wsError

      // Now fetch workspace (SELECT policy works because we're a member)
      const { data: workspace, error: fetchError } = await client
        .from('workspaces')
        .select()
        .eq('id', workspaceId)
        .single()

      if (fetchError) throw fetchError

      // Create workspace settings
      await client.from('workspace_settings').insert({
        workspace_id: workspace.id,
      })

      // Create #general channel
      const { data: general } = await client
        .from('channels')
        .insert({
          workspace_id: workspace.id,
          name: 'general',
          description: 'General discussion',
          created_by: session.user.id,
        })
        .select()
        .single()

      if (general) {
        await client.from('channel_members').insert({
          channel_id: general.id,
          profile_id: session.user.id,
          role: 'admin',
        })
      }

      // Create #random channel
      const { data: random } = await client
        .from('channels')
        .insert({
          workspace_id: workspace.id,
          name: 'random',
          description: 'Random stuff and off-topic',
          created_by: session.user.id,
        })
        .select()
        .single()

      if (random) {
        await client.from('channel_members').insert({
          channel_id: random.id,
          profile_id: session.user.id,
        })
      }

      // Seed slash commands
      const commands = [
        { command: 'remind', description: 'Set a reminder', usage_hint: '@user message in X min', type: 'builtin' },
        { command: 'poll', description: 'Create a poll', usage_hint: '"Question" "Option 1" "Option 2"', type: 'builtin' },
        { command: 'topic', description: 'Set channel topic', usage_hint: 'new topic text', type: 'builtin' },
        { command: 'invite', description: 'Invite user to channel', usage_hint: '@user', type: 'builtin' },
        { command: 'status', description: 'Set your status', usage_hint: ':emoji: status text', type: 'builtin' },
        { command: 'who', description: 'List channel members', usage_hint: '', type: 'builtin' },
      ]

      for (const cmd of commands) {
        await client.from('slash_commands').insert({
          ...cmd,
          workspace_id: workspace.id,
        })
      }

      onCreated(workspace as Workspace)
    } catch (err) {
      setError(
        err instanceof Error ? err.message
          : err && typeof err === 'object' && 'message' in err ? String(err.message)
            : 'Failed to create workspace'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <Building2 className="mx-auto h-12 w-12 text-primary mb-2" />
          <CardTitle>Create your workspace</CardTitle>
          <CardDescription>This is where your team will communicate.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name">Workspace Name</Label>
              <Input
                id="workspace-name"
                placeholder="My Team"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading || !name.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Workspace'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
