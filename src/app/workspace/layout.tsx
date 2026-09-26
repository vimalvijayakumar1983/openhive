'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { resolveWorkspaceMembership } from '@/lib/workspace-onboarding'
import { useAppStore } from '@/lib/store/app-store'
import { Sidebar } from '@/components/sidebar/sidebar'
import { ActivityPanel } from '@/components/activity/activity-panel'
import { CallPanel } from '@/components/calls/call-panel'
import { IncomingCallBanner } from '@/components/calls/incoming-call-banner'
import { WorkspaceSetup } from '@/components/workspace/workspace-setup'
import type { Profile, Workspace, WorkspaceMember, Channel } from '@/types/database'
import { Loader2 } from 'lucide-react'
import { useNotifications } from '@/hooks/use-notifications'
import { usePresence } from '@/hooks/use-presence'
import { useScheduledMessages } from '@/hooks/use-scheduled-messages'
import { useMobile } from '@/hooks/use-mobile'

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { user, workspace, setUser, setWorkspace, setWorkspaceRole, setChannels, setCurrentChannelId, sidebarOpen, setSidebarOpen } = useAppStore()
  const { isMobile, isTablet, isDesktop } = useMobile()
  const [loading, setLoading] = useState(true)
  const [showWorkspaceSetup, setShowWorkspaceSetup] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [workspaceMemberships, setWorkspaceMemberships] = useState<(WorkspaceMember & { workspace: Workspace })[]>([])

  // Enable browser notifications for mentions and DMs
  useNotifications()

  // Track user presence (online status + last_seen_at)
  usePresence()

  // Poll and send scheduled messages when due
  useScheduledMessages()

  useEffect(() => {
    loadUserData()
    // Local setup can provision storage buckets when a service key is present.
    if (process.env.NODE_ENV === 'development') {
      fetch('/api/storage', { method: 'POST' }).catch(() => {})
    }
  }, [])

  async function loadUserData() {
    const client = getSupabaseClient()
    if (!client) {
      router.push('/setup')
      return
    }

    try {
      const { data: { session } } = await client.auth.getSession()
      if (!session) {
        router.push('/auth')
        return
      }

      // Load profile
      const { data: profile } = await client
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single()

      if (!profile) {
        router.push('/auth')
        return
      }

      setUser(profile as Profile)

      // Find workspace membership
      const { data: members, error: membersError } = await client
        .from('workspace_members')
        .select('*, workspace:workspaces(*)')
        .eq('profile_id', session.user.id)
        .order('joined_at', { ascending: false })
      if (membersError) throw membersError

      const available = (members || []).filter(member => member.workspace) as (WorkspaceMember & { workspace: Workspace })[]
      setWorkspaceMemberships(available)
      const preferredKey = `openhive_workspace_${session.user.id}`
      const inviteSeenKey = `openhive_invite_seen_${session.user.id}`
      const preferredId = window.localStorage.getItem(preferredKey)
      const invitedId = session.user.user_metadata?.workspace_id as string | undefined
      const resolution = resolveWorkspaceMembership(
        available, invitedId, preferredId, window.localStorage.getItem(inviteSeenKey)
      )
      if (resolution.kind === 'invite-missing') {
        setWorkspaceError('Your invitation is not linked to its workspace. Ask your workspace admin to invite you again.')
        return
      }
      if (resolution.kind === 'member' && resolution.member.workspace) {
        const member = resolution.member
        if (resolution.newInvite && invitedId) {
          window.localStorage.setItem(preferredKey, member.workspace_id)
          window.localStorage.setItem(inviteSeenKey, invitedId)
        }
        setWorkspace(member.workspace)
        setWorkspaceRole(member.role)
        await loadChannels(member.workspace.id)
        // Load saved item IDs for bookmark state
        loadSavedItemIds(session.user.id, member.workspace.id)
      } else if (resolution.kind === 'new-user') {
        setShowWorkspaceSetup(true)
      } else {
        setWorkspaceError('We could not load your workspace. Please refresh and try again.')
      }
    } catch (err) {
      console.error('Failed to load user data:', err)
      setWorkspaceError('We could not load your workspace. Please refresh and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function loadSavedItemIds(userId: string, workspaceId: string) {
    const client = getSupabaseClient()
    if (!client) return
    try {
      const { data, error } = await client
        .from('saved_items')
        .select('message_id')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
      if (error) return // Table may not exist yet — silently ignore
      if (data) {
        const ids = new Set(data.map((d: { message_id: string }) => d.message_id))
        useAppStore.getState().setSavedItemIds(ids)
      }
    } catch {
      // saved_items table missing — feature will be unavailable until re-provisioned
    }
  }

  async function loadChannels(workspaceId: string) {
    const client = getSupabaseClient()
    if (!client) return

    const userId = useAppStore.getState().user?.id
    if (!userId) return

    // Only load channels the user is a member of
    const { data: myMemberships } = await client
      .from('channel_members')
      .select('channel_id')
      .eq('profile_id', userId)

    if (!myMemberships || myMemberships.length === 0) return

    const myChannelIds = myMemberships.map((m) => m.channel_id)

    const { data: myChannels } = await client
      .from('channels')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('is_archived', false)
      .in('id', myChannelIds)
      .order('name')

    // Filter out DM and group DM channels (they're shown separately in the DM section)
    const allChannels = ((myChannels || []) as Channel[]).filter(
      (c) => !c.name.startsWith('dm-') && !c.name.startsWith('gdm-')
    )

    if (allChannels.length > 0) {
      setChannels(allChannels)
      // Default to #general or first channel
      const general = allChannels.find((c: Channel) => c.name === 'general') || allChannels[0]
      setCurrentChannelId(general.id)
    }
  }

  async function handleWorkspaceCreated(ws: Workspace) {
    setWorkspace(ws)
    setWorkspaceRole('owner')
    const userId = useAppStore.getState().user?.id
    if (userId) {
      window.localStorage.setItem(`openhive_workspace_${userId}`, ws.id)
      setWorkspaceMemberships([{ workspace_id: ws.id, profile_id: userId, role: 'owner', joined_at: new Date().toISOString(), workspace: ws }])
    }
    setShowWorkspaceSetup(false)
    await loadChannels(ws.id)
  }

  function handleWorkspaceSelect(workspaceId: string) {
    if (!user || workspaceId === workspace?.id) return
    window.localStorage.setItem(`openhive_workspace_${user.id}`, workspaceId)
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (showWorkspaceSetup) {
    return <WorkspaceSetup onCreated={handleWorkspaceCreated} />
  }

  if (workspaceError) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-background">
        <h1 className="text-xl font-semibold">Workspace unavailable</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {workspaceError}
        </p>
        <button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    )
  }

  if (!workspace) {
    return null
  }

  return (
    <div className="h-screen flex bg-background relative overflow-hidden">
      <IncomingCallBanner />

      {/* Sidebar - Desktop: always visible, Mobile/Tablet: overlay drawer */}
      {isDesktop ? (
        <Sidebar availableWorkspaces={workspaceMemberships} onWorkspaceSelect={handleWorkspaceSelect} />
      ) : (
        <>
          {/* Backdrop */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 bg-black/30 z-40 transition-opacity"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          {/* Drawer */}
          <div className={`fixed left-0 top-0 h-full z-50 transition-transform duration-200 ease-out ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}>
            <Sidebar onNavigate={() => setSidebarOpen(false)} availableWorkspaces={workspaceMemberships} onWorkspaceSelect={handleWorkspaceSelect} />
          </div>
        </>
      )}

      <ActivityPanel />
      <main className="flex-1 flex flex-col min-w-0">{children}</main>
      <CallPanel />
    </div>
  )
}
