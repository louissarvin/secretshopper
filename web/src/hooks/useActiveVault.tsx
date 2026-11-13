import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { activeShop } from '@/lib/api/client'
import { config } from '@/config'
import { isAccountId } from '@/utils/near'

const KEY = 'ss-vault'

interface ActiveVault {
  /** The vault every owner page reads and signs for */
  vault: string
  /** Vaults the signed-in owner can switch between; this build's vault until the API lists more */
  owned: Array<string>
  setVault: (id: string) => void
}

const Ctx = createContext<ActiveVault | null>(null)

/** The vault the owner app is showing; falls back to this build's vault outside the app shell. */
export const useActiveVault = () => useContext(Ctx)?.vault ?? config.shopId
export const useVaultSwitch = () => useContext(Ctx)

const stored = () => {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function ActiveVaultProvider({
  owned,
  children,
}: {
  owned: Array<string>
  children: React.ReactNode
}) {
  const [picked, setPicked] = useState<string | null>(stored)
  // Only a vault the owner is known to own may be active; anything else falls back to the first
  const list = owned.filter(isAccountId)
  const vault =
    picked && list.includes(picked)
      ? picked
      : list.includes(config.shopId)
        ? config.shopId
        : (list[0] ?? config.shopId)
  // Owner and vendor routes act on this vault; the default vault needs no header
  activeShop.value = vault === config.shopId ? '' : vault
  // Outside the owner app (vendor console, /new) no vault header may linger
  useEffect(
    () => () => {
      activeShop.value = ''
    },
    [],
  )
  const setVault = useCallback(
    (id: string) => {
      if (!list.includes(id)) return
      setPicked(id)
      activeShop.value = id === config.shopId ? '' : id
      try {
        sessionStorage.setItem(KEY, id)
      } catch {}
    },
    [list],
  )
  return (
    <Ctx.Provider value={{ vault, owned: list, setVault }}>
      {children}
    </Ctx.Provider>
  )
}
