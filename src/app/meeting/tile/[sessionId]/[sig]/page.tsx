import { notFound } from 'next/navigation'
import { verifyStatusTile } from '@/lib/meeting/statusTile'
import { Tile } from './Tile'

export const dynamic = 'force-dynamic'

/**
 * The page Recall streams into Urushi's camera.
 *
 * Deliberately not part of the app's layout: no header, no footer, no fonts to
 * load. It is rendered at participant-thumbnail size by a headless browser and
 * has to read from across a room — three words, very large, high contrast.
 */
export default async function StatusTilePage({
  params,
}: {
  params: Promise<{ sessionId: string; sig: string }>
}) {
  const { sessionId, sig } = await params
  if (!verifyStatusTile(sessionId, sig)) notFound()
  return <Tile sessionId={sessionId} sig={sig} />
}
