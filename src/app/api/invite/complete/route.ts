import { NextResponse } from 'next/server'

/** Invitation acceptance requires a verified Supabase email link. */
export async function POST() {
  return NextResponse.json(
    { error: 'Open the invitation email link to verify your account before joining.' },
    { status: 410 }
  )
}
