-- LiveKit-signed call activity. Only the service key may insert events.
CREATE TABLE IF NOT EXISTS public.call_connection_events (
  event_id text PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES public.active_calls(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('participant_joined', 'participant_left', 'track_published', 'track_unpublished', 'room_finished')),
  participant_identity text,
  participant_sid text,
  track_source text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_connection_events_call_time_idx
  ON public.call_connection_events (call_id, occurred_at);

ALTER TABLE public.call_connection_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cce_select ON public.call_connection_events;
CREATE POLICY cce_select ON public.call_connection_events FOR SELECT USING (
  call_id IN (
    SELECT id FROM public.active_calls
    WHERE workspace_id IN (SELECT public.get_my_admin_workspace_ids())
  )
);
