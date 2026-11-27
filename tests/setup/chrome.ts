import { beforeEach, vi } from 'vitest'

type Listener<A extends unknown[]> = (...args: A) => void

export function makeEvent<A extends unknown[]>() {
  const listeners = new Set<Listener<A>>()
  return {
    addListener: (l: Listener<A>) => void listeners.add(l),
    removeListener: (l: Listener<A>) => void listeners.delete(l),
    hasListener: (l: Listener<A>) => listeners.has(l),
    /** Test helper: fire the event. */
    emit: (...args: A) => {
      for (const l of [...listeners]) l(...args)
    },
    listenerCount: () => listeners.size,
  }
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>
type Rec = Record<string, unknown>

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

function makeStorageArea(name: string, onAnyChanged: (c: Changes, area: string) => void) {
  let data: Rec = {}
  const onChanged = makeEvent<[Changes]>()
  const fire = (c: Changes) => {
    if (Object.keys(c).length === 0) return
    onChanged.emit(c)
    onAnyChanged(c, name)
  }
  const area = {
    accessLevel: undefined as string | undefined,
    onChanged,
    /** Test helper: the raw stored data. */
    dump: (): Rec => structuredClone(data),
    get: vi.fn(async (keys?: string | string[] | Rec | null): Promise<Rec> => {
      if (keys === undefined || keys === null) return clone(data)
      const out: Rec = {}
      if (typeof keys === 'string') {
        if (keys in data) out[keys] = clone(data[keys])
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (k in data) out[k] = clone(data[k])
      } else {
        for (const [k, def] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : clone(def)
      }
      return out
    }),
    set: vi.fn(async (items: Rec): Promise<void> => {
      const changes: Changes = {}
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { newValue: clone(v) }
        if (k in data) changes[k]!.oldValue = clone(data[k])
        data[k] = clone(v)
      }
      fire(changes)
    }),
    remove: vi.fn(async (keys: string | string[]): Promise<void> => {
      const changes: Changes = {}
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in data) {
          changes[k] = { oldValue: data[k] }
          delete data[k]
        }
      }
      fire(changes)
    }),
    clear: vi.fn(async (): Promise<void> => {
      const changes: Changes = {}
      for (const [k, v] of Object.entries(data)) changes[k] = { oldValue: v }
      data = {}
      fire(changes)
    }),
    setAccessLevel: vi.fn(async (opts: { accessLevel: string }): Promise<void> => {
      area.accessLevel = opts.accessLevel
    }),
  }
  return area
}

export function createChromeFake() {
  const storageOnChanged = makeEvent<[Changes, string]>()
  const areaFor = (name: string) => makeStorageArea(name, (c, n) => storageOnChanged.emit(c, n))
  const granted = new Set<string>()
  const alarms = new Map<string, { name: string; periodInMinutes?: number; delayInMinutes?: number }>()
  const notifications = new Map<string, unknown>()
  const menus = new Map<string, unknown>()
  const badge = { text: '', color: undefined as unknown }

  const fake = {
    storage: { local: areaFor('local'), session: areaFor('session'), onChanged: storageOnChanged },
    permissions: {
      granted,
      /** Test helper: what the next request() answers. */
      nextRequest: true as boolean,
      request: vi.fn(async (p: { origins?: string[] }): Promise<boolean> => {
        if (!fake.permissions.nextRequest) return false
        for (const o of p.origins ?? []) granted.add(o)
        return true
      }),
      remove: vi.fn(async (p: { origins?: string[] }): Promise<boolean> => {
        for (const o of p.origins ?? []) granted.delete(o)
        return true
      }),
      contains: vi.fn(async (p: { origins?: string[] }): Promise<boolean> =>
        (p.origins ?? []).every((o) => granted.has(o)),
      ),
    },
    identity: {
      redirectUrl: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
      getRedirectURL: vi.fn((path = ''): string => fake.identity.redirectUrl + path),
      launchWebAuthFlow: vi.fn<(opts: { url: string; interactive?: boolean }) => Promise<string | undefined>>(
        async () => {
          throw new Error('launchWebAuthFlow not stubbed')
        },
      ),
    },
    alarms: {
      map: alarms,
      create: vi.fn(async (name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
        alarms.set(name, { name, ...info })
      }),
      clear: vi.fn(async (name?: string) => (name === undefined ? false : alarms.delete(name))),
      clearAll: vi.fn(async () => {
        alarms.clear()
        return true
      }),
      get: vi.fn(async (name?: string) => (name === undefined ? undefined : alarms.get(name))),
      getAll: vi.fn(async () => [...alarms.values()]),
      onAlarm: makeEvent<[{ name: string }]>(),
    },
    action: {
      badge,
      setBadgeText: vi.fn(async (d: { text: string }) => void (badge.text = d.text)),
      setBadgeBackgroundColor: vi.fn(async (d: { color: unknown }) => void (badge.color = d.color)),
    },
    notifications: {
      map: notifications,
      create: vi.fn(async (id: string | undefined, opts: unknown) => {
        const key = id ?? `n${notifications.size + 1}`
        notifications.set(key, opts)
        return key
      }),
      clear: vi.fn(async (id: string) => notifications.delete(id)),
      onClicked: makeEvent<[string]>(),
    },
    contextMenus: {
      map: menus,
      create: vi.fn((props: { id?: string | number }, cb?: () => void) => {
        const id = props.id ?? menus.size + 1
        menus.set(String(id), props)
        cb?.()
        return id
      }),
      remove: vi.fn(async (id: string | number) => void menus.delete(String(id))),
      removeAll: vi.fn(async () => void menus.clear()),
      onClicked: makeEvent<[unknown, unknown?]>(),
    },
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      sendMessage: vi.fn<(msg: unknown) => Promise<unknown>>(async () => undefined),
      onMessage: makeEvent<[unknown, unknown, (r?: unknown) => void]>(),
      onStartup: makeEvent<[]>(),
      onInstalled: makeEvent<[{ reason: string }]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: makeEvent<[number]>(),
      lastFocusedId: 1,
      getLastFocused: vi.fn(async () => ({ id: fake.windows.lastFocusedId })),
    },
    sidePanel: {
      open: vi.fn<(opts: { tabId?: number; windowId?: number }) => Promise<void>>(async () => undefined),
      setPanelBehavior: vi.fn<(b: { openPanelOnActionClick?: boolean }) => Promise<void>>(
        async () => undefined,
      ),
    },
  }
  return fake
}

export type ChromeFake = ReturnType<typeof createChromeFake>
let current: ChromeFake

/** Installs a fresh fake as `globalThis.chrome` and returns it. */
export function resetChrome(): ChromeFake {
  current = createChromeFake()
  ;(globalThis as unknown as { chrome: unknown }).chrome = current
  return current
}

export const getChromeFake = (): ChromeFake => current

resetChrome()
beforeEach(() => {
  resetChrome()
})
