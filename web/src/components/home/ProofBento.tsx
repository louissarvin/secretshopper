import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import CountUp from '@/components/elements/CountUp'
import DecryptedText from '@/components/elements/DecryptedText'
import {
  useAccessKeys,
  usePublicTest,
  usePublicTests,
  useTestSlot,
  useVerifyReport,
} from '@/hooks/useShop'
import { isVaultAgentScope, keyScope } from '@/lib/near/proofs'
import { short } from '@/utils/near'
import { config, explorerTx } from '@/config'

export default function ProofBento() {
  const bento = useRef<HTMLDivElement>(null)
  const chips = useRef<HTMLDivElement>(null)
  const keys = useAccessKeys(config.shopId)
  const scopes = keys.data?.map((k) => ({
    k,
    s: keyScope(k.access_key.permission),
  }))
  const full = scopes?.filter((x) => x.s.kind === 'full').length
  const agent = scopes?.find((x) => isVaultAgentScope(x.s, config.shopId))
  const report = useVerifyReport()
  // The other three cells show the real artefacts behind each claim
  const slots = usePublicTests(config.shopId).data?.pages.flatMap(
    (p) => p.items,
  )
  const newest = slots?.[0]
  const sealed = useTestSlot(
    config.shopId,
    newest?.slotIndex ?? -1,
    newest !== undefined,
  ).data
  const failedSlot = slots?.find((t) => t.status === 'Failed')?.slotIndex
  const failed = usePublicTest(
    config.shopId,
    failedSlot ?? -1,
    failedSlot !== undefined,
  ).data
  const lureSlot = slots?.find((t) =>
    ['Passed', 'Failed'].includes(t.status),
  )?.slotIndex
  const receipt = usePublicTest(
    config.shopId,
    lureSlot ?? -1,
    lureSlot !== undefined,
  ).data?.receipt
  const counts = report.data?.counts
  const contractParts = counts
    ? [
        counts.contractSandbox,
        counts.contractAudit,
        counts.contractUnit,
        counts.contractCost,
      ]
    : []
  const contractTests =
    contractParts.length && contractParts.every((n) => n !== null)
      ? contractParts.reduce((a, n) => a + n, 0)
      : null
  const buildMatches = report.data?.steps.some(
    (x) =>
      /wasm build/.test(x.step) &&
      x.status === 'pass' &&
      x.summary.includes('checksum'),
  )
  // Every figure comes from the committed `bun run verify` result
  const testLine = report.isError
    ? 'The test report is not available right now.'
    : !counts
      ? 'Reading the last test run…'
      : [
          contractTests !== null &&
            `${counts.contractSandbox} sandbox, ${counts.contractAudit} audit regressions, ${counts.contractUnit} unit, ${counts.contractCost} cost profile.`,
          counts.demoChecks !== null &&
            `${counts.demoChecks} checks in the end-to-end demo.`,
          counts.backendPass !== null &&
            `${counts.backendPass} backend tests passing.`,
          counts.agentPass !== null &&
            `${counts.agentPass} agent tests passing.`,
          buildMatches && 'The contract build matches the deployed code.',
          report.data?.generatedAt &&
            `As of ${report.data.generatedAt.slice(0, 10)}.`,
        ]
          .filter(Boolean)
          .join(' ')

  // Magic Bento: one border glow that follows the pointer across the grid
  useEffect(() => {
    const el = bento.current!
    const cells = () => Array.from(el.querySelectorAll<HTMLElement>('.cell'))
    const move = (e: PointerEvent) =>
      cells().forEach((c) => {
        const r = c.getBoundingClientRect()
        c.style.setProperty('--mx', `${e.clientX - r.left}px`)
        c.style.setProperty('--my', `${e.clientY - r.top}px`)
      })
    const leave = () =>
      cells().forEach(
        (c) => (
          c.style.setProperty('--mx', '-999px'),
          c.style.setProperty('--my', '-999px')
        ),
      )
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches)
      return () => (
        el.removeEventListener('pointermove', move),
        el.removeEventListener('pointerleave', leave)
      )
    const ring = gsap.to(el.querySelector('#ringArc'), {
      strokeDashoffset: 314.2,
      duration: 6,
      ease: 'none',
      repeat: -1,
    })
    const ch = Array.from(chips.current!.children)
    const loop = gsap
      .timeline({ repeat: -1, repeatDelay: 0.6 })
      .call(() => ch.forEach((c) => c.classList.remove('on')))
      .call(() => ch[0].classList.add('on'), [], 0.6)
      .call(() => ch[1].classList.add('on'), [], 1.1)
      .call(() => ch[2].classList.add('on'), [], 1.6)
      .to({}, { duration: 1.2 }, 1.6)
    const reveal = gsap.from(el.querySelectorAll('.cell'), {
      y: 70,
      opacity: 0,
      duration: 1.1,
      ease: 'expo.out',
      stagger: 0.08,
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    })
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      ring.kill()
      loop.kill()
      reveal.scrollTrigger?.kill()
    }
  }, [])

  return (
    <section className="proof" id="proof">
      <div className="wrap">
        <div className="grid12 phead">
          <h2 className="disp rv">
            <span className="mline">
              <span>Nobody</span>
            </span>
            <span className="mline">
              <span className="cob">can fake it.</span>
            </span>
          </h2>
          <p>
            The vendor can't. The company can't. The rules live in the contract
            that holds the money, and every number here can be checked against
            the chain.
          </p>
        </div>
        <div className="bento" ref={bento}>
          <div className="cell w3">
            <div className="in">
              <span className="label">Locked vault · live</span>
              <div className="vis">
                <span className="big">{full ?? '–'}</span>
              </div>
              <div>
                <h3>Full-access keys</h3>
                <p>
                  Nobody holds a key that can rewrite the vault. The agent key
                  is function-call only.{' '}
                  <span className="src">view_access_key_list</span>
                </p>
                <div className="keys">
                  {agent ? (
                    <>
                      <b>
                        <DecryptedText
                          text={short(agent.k.public_key, 14, 6)}
                        />
                      </b>{' '}
                      {agent.s.kind === 'function' &&
                        `${agent.s.gasKey ? 'GasKeyFunctionCall' : 'FunctionCall'} ${agent.s.methods.join(', ')}`}
                    </>
                  ) : keys.isError ? (
                    'Key list unavailable right now'
                  ) : keys.data ? (
                    'No agent key armed'
                  ) : (
                    'Reading keys…'
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="cell w3">
            <div className="in">
              <span className="label">Tested</span>
              <div className="vis">
                {contractTests !== null ? (
                  <CountUp className="big" to={contractTests} duration={1.6} />
                ) : (
                  <span className="big">–</span>
                )}
              </div>
              <div>
                <h3>Contract tests</h3>
                <p>{testLine}</p>
                <span className="src">GET /public/verify-report</span>
              </div>
            </div>
          </div>
          <div className="cell">
            <div className="in">
              <span className="label">Timelock</span>
              <div className="vis">
                <div className="ringbox">
                  <svg viewBox="0 0 112 112" aria-hidden="true">
                    <circle
                      cx="56"
                      cy="56"
                      r="50"
                      stroke="rgba(235,234,230,.14)"
                    />
                    <circle
                      id="ringArc"
                      cx="56"
                      cy="56"
                      r="50"
                      stroke="#3A4CFF"
                      strokeDasharray="314.2"
                      strokeDashoffset="90"
                      transform="rotate(-90 56 56)"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span>
                    drand
                    <br />
                    {sealed ? `round ${sealed.tlock_round}` : 'quicknet'}
                  </span>
                </div>
              </div>
              <div>
                <h3>Sealed until expiry</h3>
                <p>
                  Answer keys are encrypted to a drand round. Anyone can reveal
                  once it opens.
                  {sealed && newest
                    ? ` Slot ${newest.slotIndex}, the newest, is ${newest.revealed ? 'revealed' : 'still sealed'}.`
                    : ''}
                </p>
                <span className="src">get_test.tlock_round</span>
              </div>
            </div>
          </div>
          <div className="cell">
            <div className="in">
              <span className="label">One receipt</span>
              <div className="vis">
                <div className="chips" ref={chips}>
                  <span>DeleteKey</span>
                  <span>AddKey</span>
                  <span>propose</span>
                </div>
              </div>
              <div>
                <h3>Demotion is atomic</h3>
                <p>
                  Same public key, new method list, one batched receipt. No
                  window where the agent can still pay.
                </p>
                {failed?.demotion && (
                  <a
                    className="txl"
                    href={explorerTx(failed.demotion.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    The real one: slot {failed.slotIndex},{' '}
                    {short(failed.demotion.txHash, 6, 4)}
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="cell">
            <div className="in">
              <span className="label">NEAR AI</span>
              <div className="vis">
                <div className="shine">
                  {receipt
                    ? `${receipt.signatureKind} · ${receipt.signingAlgo} · ${receipt.assurance}`
                    : 'provider_tee · ecdsa · sha256(request) == signedText'}
                </div>
              </div>
              <div>
                <h3>Signed by the model</h3>
                <p>
                  Every lure and every agent step carries a NEAR AI receipt. The
                  lure's receipt is sealed into its commitment.
                  {receipt && lureSlot !== undefined
                    ? ` The newest lure, slot ${lureSlot}, was written by ${receipt.model}.`
                    : ''}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
