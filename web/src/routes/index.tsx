import { Link, createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import SiteNav from '@/components/SiteNav'
import { Hero, Loader, Statement, VelocityBand } from '@/components/home/Hero'
import Drill from '@/components/home/Drill'
import SpotTheFake from '@/components/home/SpotTheFake'
import LiveScore from '@/components/home/LiveScore'
import ProofBento from '@/components/home/ProofBento'
import StartCta from '@/components/home/StartCta'
import HomeFooter from '@/components/home/HomeFooter'
import { useReveal } from '@/hooks/useReveal'
import { scrollToTarget } from '@/lib/lenis'
import { config } from '@/config'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const [ready, setReady] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useReveal(root)
  const anchor =
    (id: string, offset = -90) =>
    (e: React.MouseEvent) => (e.preventDefault(), scrollToTarget(id, offset))

  return (
    <div className="home" ref={root}>
      <Loader onDone={() => setReady(true)} />
      <SiteNav
        links={
          <>
            <a href="#drill" onClick={anchor('#drill', 0)}>
              How it works
            </a>
            <a href="#guess" onClick={anchor('#guess')}>
              Spot the fake
            </a>
            <Link to="/s/$shopId" params={{ shopId: config.shopId }}>
              Scorecard
            </Link>
          </>
        }
      />
      <main>
        <Hero ready={ready} />
        <VelocityBand />
        <Statement />
        <Drill />
        <SpotTheFake />
        <LiveScore />
        <ProofBento />
        <StartCta />
      </main>
      <HomeFooter />
    </div>
  )
}
