import {describe, expect, it} from 'vitest'
import {createDefaultWorkspace} from '../defaults'
import {createDefaultBackupPlan} from '../backupPlanHelpers'
import {exportMowerJson, importMowerJson} from './mowerJson'
import {decodeRosterFrom16QrChunks, encodeRosterTo16QrChunks} from './mowerQrCodec'

// Native 94a config.plan Trigger|FunctionTrigger: expression text is a Trigger.left,
// not a primitive trigger. Extra fields and unedited native ASTs remain intact.
describe('native Mower trigger export', () => {
  it('exports edited text conditions as native Trigger objects through JSON and QR', () => {
    const workspace = createDefaultWorkspace()
    const native = {function:'all',args:[{left:'True',operator:'and',right:'True',future:{keep:1}}],future:['untouched']}
    workspace.compatibility.backupPlans = [createDefaultBackupPlan(1),{name:'native',trigger:native}]
    workspace.compatibility.unrecognizedFields.backup_groups = [
      {id:'custom',name:'Custom',trigger:'False',future:{keep:2}},
      {id:'native',name:'Native',trigger:native},
    ]
    const before = JSON.stringify(workspace)
    const text = exportMowerJson(workspace)
    const json = JSON.parse(text)
    const qr = JSON.parse(decodeRosterFrom16QrChunks(encodeRosterTo16QrChunks(text,14)))
    for (const document of [json,qr]) {
      expect(document.backup_plans[0].trigger).toEqual({left:'True',operator:'',right:''})
      expect(document.backup_groups[0]).toEqual({id:'custom',name:'Custom',trigger:{left:'False',operator:'',right:''},future:{keep:2}})
      expect(document.backup_plans[1].trigger).toEqual(native)
      expect(document.backup_groups[1].trigger).toEqual(native)
    }
    expect(JSON.stringify(workspace)).toBe(before)
    expect(JSON.parse(exportMowerJson(importMowerJson(text)))).toEqual(json)
  })
})
