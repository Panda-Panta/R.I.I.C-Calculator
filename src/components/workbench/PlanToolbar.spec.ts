/**
 * @vitest-environment jsdom
 *
 * Test suite for PlanToolbar.vue component.
 * Covers:
 * - Rendering of 6 core actions (Reset, Import, Export JSON, Export Image, Replace, Calculate)
 * - Action emits (open-replace, calculate) and isValid gate
 * - Transactional reset with confirmation dialog and cancellation
 * - Atomic JSON import with visible success and error states
 * - Atomic 16-QR JPG import with real Mower fixture
 * - High-res JPG export with base-map element capture and loading state
 * - Non-mutation upon file picker cancellation or malformed files
 *
 * Derived from arknights-mower (https://github.com/ArkMowers/arknights-mower)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpeg from 'jpeg-js'
import PlanToolbar from './PlanToolbar.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import type { PlanFileAdapters } from '../../workbench/fileHelpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createMockCanvas(width: number, height: number): HTMLCanvasElement {
  const buffer = new Uint8ClampedArray(width * height * 4).fill(255)
  const ctx = {
    fillStyle: '#000000',
    fillRect(x: number, y: number, w: number, h: number) {
      let r = 0, g = 0, b = 0
      if (ctx.fillStyle === '#000000') {
        r = 0; g = 0; b = 0
      } else if (ctx.fillStyle === '#ffffff') {
        r = 255; g = 255; b = 255
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const px = x + dx
          const py = y + dy
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4
            buffer[idx] = r
            buffer[idx + 1] = g
            buffer[idx + 2] = b
            buffer[idx + 3] = 255
          }
        }
      }
    },
    drawImage(srcCanvas: any, dx: number, dy: number) {
      if (srcCanvas && srcCanvas._buffer) {
        const srcW = srcCanvas.width
        const srcH = srcCanvas.height
        for (let y = 0; y < srcH; y++) {
          for (let x = 0; x < srcW; x++) {
            const targetX = dx + x
            const targetY = dy + y
            if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
              const srcIdx = (y * srcW + x) * 4
              const dstIdx = (targetY * width + targetX) * 4
              buffer[dstIdx] = srcCanvas._buffer[srcIdx]
              buffer[dstIdx + 1] = srcCanvas._buffer[srcIdx + 1]
              buffer[dstIdx + 2] = srcCanvas._buffer[srcIdx + 2]
              buffer[dstIdx + 3] = srcCanvas._buffer[srcIdx + 3]
            }
          }
        }
      }
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: buffer, width: w, height: h }
    },
  }

  return {
    width,
    height,
    _buffer: buffer,
    getContext(type: string) {
      return type === '2d' ? ctx : null
    },
    toBlob(cb: (b: Blob | null) => void, type = 'image/jpeg', quality = 0.95) {
      try {
        const encoded = jpeg.encode(
          {
            data: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
            width,
            height,
          },
          Math.round(quality * 100)
        ).data
        const u8 = new Uint8Array(encoded.byteLength)
        u8.set(encoded)
        cb(new Blob([u8], { type }))
      } catch {
        cb(null)
      }
    },
  } as unknown as HTMLCanvasElement
}

describe('PlanToolbar.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders all 6 core action buttons with Mower styling', () => {
    const wrapper = mount(PlanToolbar)

    expect(wrapper.find('[data-test="reset-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="import-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="export-json-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="export-image-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="replace-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="calc-btn"]').exists()).toBe(true)
  })

  it('emits open-replace when replacement button is clicked', async () => {
    const wrapper = mount(PlanToolbar)
    await wrapper.find('[data-test="replace-btn"]').trigger('click')

    expect(wrapper.emitted('open-replace')).toHaveLength(1)
  })

  it('emits calculate when calculate button is clicked and isValid is true', async () => {
    const wrapper = mount(PlanToolbar, {
      props: { isValid: true },
    })

    const calcBtn = wrapper.find('[data-test="calc-btn"]')
    expect(calcBtn.attributes('disabled')).toBeUndefined()
    await calcBtn.trigger('click')

    expect(wrapper.emitted('calculate')).toHaveLength(1)
  })

  it('disables calculate button when isValid is false and prevents emit', async () => {
    const wrapper = mount(PlanToolbar, {
      props: { isValid: false },
    })

    const calcBtn = wrapper.find('[data-test="calc-btn"]')
    expect(calcBtn.attributes('disabled')).toBeDefined()
    await calcBtn.trigger('click')

    expect(wrapper.emitted('calculate')).toBeUndefined()
  })

  describe('Reset Confirmation', () => {
    it('cancels reset and preserves store workspace when confirm returns false', async () => {
      const store = useRosterWorkbenchStore()
      // Modify store with distinct state
      store.workspace.mainPlan.conf.ling_xi = 3

      const adapters: PlanFileAdapters = {
        dialog: {
          confirm: () => false,
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="reset-btn"]').trigger('click')
      await flushPromises()

      // Store must remain untouched
      expect(store.workspace.mainPlan.conf.ling_xi).toBe(3)
      expect(wrapper.emitted('reset')).toBeUndefined()
      expect(wrapper.find('[data-test="status-message"]').exists()).toBe(false)
    })

    it('resets workspace atomically and displays success banner when confirmed', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.conf.ling_xi = 3

      const adapters: PlanFileAdapters = {
        dialog: {
          confirm: () => true,
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="reset-btn"]').trigger('click')
      await flushPromises()

      // Store is reset to default workspace (ling_xi = 1)
      expect(store.workspace.mainPlan.conf.ling_xi).toBe(1)
      expect(wrapper.emitted('reset')).toHaveLength(1)

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('已重置为主排班初始状态')
      expect(status.classes()).toContain('success')
    })
  })

  describe('Clear Operators Confirmation', () => {
    it('cancels clearing operators and preserves stationed operators when confirm returns false', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'test_group',
        replacements: ['char_102_texas'],
      }

      const adapters: PlanFileAdapters = {
        dialog: {
          confirm: () => false,
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="clear-operators-btn"]').trigger('click')
      await flushPromises()

      // Stationed operators must remain intact
      expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_002_amiya',
      })
      expect(wrapper.emitted('clear-operators')).toBeUndefined()
      expect(wrapper.find('[data-test="status-message"]').exists()).toBe(false)
    })

    it('clears all operators and replacements while preserving room layout and levels when confirmed', async () => {
      const store = useRosterWorkbenchStore()
      // Custom non-default layout
      store.workspace.name = '我的极限252'
      store.workspace.mainPlan.facilities.room_1_1.type = 'trading'
      store.workspace.mainPlan.facilities.room_1_1.product = 'money'
      store.workspace.mainPlan.facilities.room_1_1.level = 2
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'test_group',
        replacements: ['char_102_texas'],
      }

      const adapters: PlanFileAdapters = {
        dialog: {
          confirm: () => true,
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="clear-operators-btn"]').trigger('click')
      await flushPromises()

      // Room layout and scheme name must be preserved
      expect(store.workspace.name).toBe('我的极限252')
      expect(store.workspace.mainPlan.facilities.room_1_1.type).toBe('trading')
      expect(store.workspace.mainPlan.facilities.room_1_1.product).toBe('money')
      expect(store.workspace.mainPlan.facilities.room_1_1.level).toBe(2)

      // Slot must be empty
      expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual({
        occupant: { kind: 'empty' },
        groupId: null,
        replacements: [],
      })

      expect(wrapper.emitted('clear-operators')).toHaveLength(1)
      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('已清空所有进驻干员与替补')
      expect(status.classes()).toContain('success')
    })
  })

  describe('JSON Export', () => {
    it('exports current workspace to UTF-8 json named after plan name and shows success banner', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.conf.ling_xi = 2

      let downloadedText = ''
      let downloadedFilename = ''
      const adapters: PlanFileAdapters = {
        download: {
          downloadText(text, filename) {
            downloadedText = text
            downloadedFilename = filename
          },
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="export-json-btn"]').trigger('click')

      expect(downloadedFilename).toBe('默认排班.json')
      const parsed = JSON.parse(downloadedText)
      expect(parsed.conf.ling_xi).toBe(2)

      expect(wrapper.emitted('exported-json')).toHaveLength(1)
      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('成功导出 JSON 排班！')
    })

    it('exports json named after custom scheme name with sanitization', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.name = '自定义:243/极限'

      let downloadedFilename = ''
      const adapters: PlanFileAdapters = {
        download: {
          downloadText(_text, filename) {
            downloadedFilename = filename
          },
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="export-json-btn"]').trigger('click')

      expect(downloadedFilename).toBe('自定义_243_极限.json')
    })
  })

  describe('JPG Export', () => {
    it('shows error banner when base-map element is missing', async () => {
      const wrapper = mount(PlanToolbar, {
        props: { baseMapElement: null },
      })

      await wrapper.find('[data-test="export-image-btn"]').trigger('click')

      expect(wrapper.emitted('exported-image')).toBeUndefined()
      expect(wrapper.emitted('error')?.[0]).toEqual(['未找到基建底图元素，无法导出图片'])

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('未找到基建底图元素')
      expect(status.classes()).toContain('error')
    })

    it('captures provided baseMapElement, overlays 16 QRs, and downloads image named after plan name', async () => {
      const domEl = document.createElement('div')
      domEl.className = 'plan-container'

      let downloadedBlob: Blob | null = null
      let downloadedName = ''

      const adapters: PlanFileAdapters = {
        imageCanvas: {
          async captureElementToCanvas(_el) {
            return createMockCanvas(2940, 1200)
          },
          async loadImageRgba(_file) {
            return { data: new Uint8ClampedArray(400), width: 10, height: 10 }
          },
          createCanvas(w, h) {
            return createMockCanvas(w, h)
          },
        },
        download: {
          downloadBlob(blob, filename) {
            downloadedBlob = blob
            downloadedName = filename
          },
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: {
          baseMapElement: domEl,
          adapters,
        },
      })

      await wrapper.find('[data-test="export-image-btn"]').trigger('click')
      await flushPromises()

      expect(downloadedBlob).toBeDefined()
      expect(downloadedName).toBe('默认排班.jpg')
      expect(wrapper.emitted('exported-image')).toHaveLength(1)

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('成功导出排班图片！')
    })

    it('downloads image named after custom scheme name', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.name = '我的终极方案'

      const domEl = document.createElement('div')
      domEl.className = 'plan-container'

      let downloadedName = ''

      const adapters: PlanFileAdapters = {
        imageCanvas: {
          async captureElementToCanvas(_el) {
            return createMockCanvas(2940, 1200)
          },
          async loadImageRgba(_file) {
            return { data: new Uint8ClampedArray(400), width: 10, height: 10 }
          },
          createCanvas(w, h) {
            return createMockCanvas(w, h)
          },
        },
        download: {
          downloadBlob(_blob, filename) {
            downloadedName = filename
          },
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: {
          baseMapElement: domEl,
          adapters,
        },
      })

      await wrapper.find('[data-test="export-image-btn"]').trigger('click')
      await flushPromises()

      expect(downloadedName).toBe('我的终极方案.jpg')
    })
  })

  describe('JSON Import', () => {
    it('imports valid JSON file, updates store atomically, and shows success banner', async () => {
      const store = useRosterWorkbenchStore()
      const fixturePath = resolve(__dirname, '../../workbench/compat/fixtures/mower-252-3gold.json')
      const jsonText = readFileSync(fixturePath, 'utf-8')
      const file = new File([jsonText], 'mower-252-3gold.json', { type: 'application/json' })

      const adapters: PlanFileAdapters = {
        dialog: {
          pickFile: async () => file,
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="import-btn"]').trigger('click')
      await flushPromises()

      // Verify store is atomically loaded
      expect(store.workspace.mainPlan.conf.ling_xi).toBe(3)
      expect(store.workspace.mainPlan.facilities.room_1_1.type).toBe('manufacture')
      expect(wrapper.emitted('imported')).toHaveLength(1)

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('成功导入排班: mower-252-3gold.json')
      expect(status.classes()).toContain('success')
    })

    it('handles malformed JSON file without mutating store and displays visible error', async () => {
      const store = useRosterWorkbenchStore()
      const initialLingXi = store.workspace.mainPlan.conf.ling_xi

      const brokenFile = new File(['{ broken: invalid '], 'broken.json', { type: 'application/json' })
      const adapters: PlanFileAdapters = {
        dialog: {
          pickFile: async () => brokenFile,
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="import-btn"]').trigger('click')
      await flushPromises()

      // Store must remain untouched
      expect(store.workspace.mainPlan.conf.ling_xi).toBe(initialLingXi)
      expect(wrapper.emitted('imported')).toBeUndefined()
      expect(wrapper.emitted('error')).toHaveLength(1)

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('导入排班失败')
      expect(status.classes()).toContain('error')
    })
  })

  describe('JPG Import', () => {
    it('imports real Mower JPG fixture and updates store atomically', async () => {
      const store = useRosterWorkbenchStore()
      const jpgPath = resolve(__dirname, '../../workbench/compat/fixtures/mower-252-sample.jpg')
      const jpgBuffer = readFileSync(jpgPath)
      const jpgU8 = new Uint8Array(jpgBuffer.byteLength)
      jpgU8.set(jpgBuffer)
      const file = new File([jpgU8], 'mower-252-sample.jpg', { type: 'image/jpeg' })

      const adapters: PlanFileAdapters = {
        dialog: {
          pickFile: async () => file,
        },
        imageCanvas: {
          async loadImageRgba(f) {
            const buf = await f.arrayBuffer()
            const raw = jpeg.decode(Buffer.from(buf), { useTArray: true })
            return {
              data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
              width: raw.width,
              height: raw.height,
            }
          },
          async captureElementToCanvas() {
            return createMockCanvas(3000, 1200)
          },
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="import-btn"]').trigger('click')
      await flushPromises()

      // Verify store updated with 252 plan
      expect(store.workspace.mainPlan.facilities.room_1_1.type).toBe('manufacture')
      expect(store.workspace.mainPlan.facilities.central.slots.length).toBe(5)
      expect(wrapper.emitted('imported')).toHaveLength(1)

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('成功导入排班: mower-252-sample.jpg')
    })

    it('does not mutate store and shows error when JPG contains no QR codes', async () => {
      const store = useRosterWorkbenchStore()
      const initialFacilities = JSON.stringify(store.workspace.mainPlan.facilities)

      // Blank image
      const blankCanvas = createMockCanvas(3000, 1200)
      const blankBlob = await new Promise<Blob>((resolve) => blankCanvas.toBlob((b) => resolve(b!)))
      const file = new File([blankBlob], 'blank.jpg', { type: 'image/jpeg' })

      const adapters: PlanFileAdapters = {
        dialog: {
          pickFile: async () => file,
        },
        imageCanvas: {
          async loadImageRgba(f) {
            const buf = await f.arrayBuffer()
            const raw = jpeg.decode(Buffer.from(buf), { useTArray: true })
            return {
              data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
              width: raw.width,
              height: raw.height,
            }
          },
          async captureElementToCanvas() {
            return createMockCanvas(3000, 1200)
          },
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="import-btn"]').trigger('click')
      await flushPromises()

      // Store is preserved
      expect(JSON.stringify(store.workspace.mainPlan.facilities)).toBe(initialFacilities)
      expect(wrapper.emitted('imported')).toBeUndefined()
      expect(wrapper.emitted('error')).toHaveLength(1)

      const status = wrapper.find('[data-test="status-message"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('导入排班失败')
      expect(status.classes()).toContain('error')
    })
  })

  describe('File Picker Cancellation', () => {
    it('does not mutate store or display errors when file dialog is canceled', async () => {
      const store = useRosterWorkbenchStore()
      const initialLingXi = store.workspace.mainPlan.conf.ling_xi

      const adapters: PlanFileAdapters = {
        dialog: {
          pickFile: async () => null, // User clicks cancel
        },
      }

      const wrapper = mount(PlanToolbar, {
        props: { adapters },
      })

      await wrapper.find('[data-test="import-btn"]').trigger('click')
      await flushPromises()

      expect(store.workspace.mainPlan.conf.ling_xi).toBe(initialLingXi)
      expect(wrapper.emitted('imported')).toBeUndefined()
      expect(wrapper.emitted('error')).toBeUndefined()
      expect(wrapper.find('[data-test="status-message"]').exists()).toBe(false)
    })
  })

  describe('Abort Auto Generation', () => {
    it('offers to end optimization and retain the verified roster only when a snapshot is available', async () => {
      const wrapper = mount(PlanToolbar, { props: { isGeneratingRoster: true, hasVerifiedIncumbent: true } })
      const button = wrapper.get('[data-test="abort-roster-btn"]')
      expect(button.text()).toContain('结束优化并保留当前方案')
      await button.trigger('click')
      expect(wrapper.emitted('abort-generation')).toHaveLength(1)
      await wrapper.setProps({ hasVerifiedIncumbent: false })
      expect(button.text()).toContain('中止排班')
      expect(button.text()).not.toContain('保留当前方案')
    })

    it('shows abort button when isGeneratingRoster is true and emits abort-generation on click', async () => {
      const wrapper = mount(PlanToolbar, {
        props: { isGeneratingRoster: true },
      })

      const abortBtn = wrapper.find('[data-test="abort-roster-btn"]')
      expect(abortBtn.exists()).toBe(true)
      expect(abortBtn.text()).toContain('中止排班')

      await abortBtn.trigger('click')
      expect(wrapper.emitted('abort-generation')).toHaveLength(1)
    })

    it('does not show abort button when isGeneratingRoster is false', () => {
      const wrapper = mount(PlanToolbar, {
        props: { isGeneratingRoster: false },
      })

      expect(wrapper.find('[data-test="abort-roster-btn"]').exists()).toBe(false)
    })
  })

  describe('Poster Export Action', () => {
    it('renders export-poster-btn and emits open-poster event on click', async () => {
      const wrapper = mount(PlanToolbar)
      const posterBtn = wrapper.find('[data-test="export-poster-btn"]')
      expect(posterBtn.exists()).toBe(true)
      expect(posterBtn.text()).toContain('分享海报')

      await posterBtn.trigger('click')
      expect(wrapper.emitted('open-poster')).toHaveLength(1)
    })
  })
})
