import { describe, expect, it } from 'vitest'
import { projectToolOutput } from '../loop/tool-result-output'
import { CODE_RUN_RESULT_SCHEMA, isOutputPart } from '@creatorweave/shared/code-output'
import { assertSchemaValue, createSchemaValidator } from '@creatorweave/shared/webmcp-schema'

const image = {type:'image' as const,data:'iVBORw0KGgo=',mimeType:'image/png'}
const envelope = (data: unknown, contentParts?: unknown[]) => ({ok:true,version:2,tool:'test',data,...(contentParts?{contentParts}:{})})
describe('Agent output projection', () => {
  it('renders only explicit top-level execution output', () => {
    const nested = {ok:true,value:null,output:[image]}
    const result = projectToolOutput('run_code',envelope({ok:true,value:nested,output:[{type:'text',text:'selected'}]}),'fallback')
    expect(result.output).toEqual([{type:'text',text:'selected'}])
    expect(JSON.parse(result.text).data.value).toEqual(nested)
    expect(projectToolOutput('call_tool',envelope({result:nested}),'JSON').output).toEqual([])
  })
  it('projects direct read_image as metadata plus bytes exactly once', () => {
    const result = projectToolOutput('read_image',envelope({...image,path:'chart.png',width:1,height:1}),'fallback')
    expect(result.text).not.toContain(image.data)
    expect(result.text).toContain('chart.png')
    expect(result.output).toHaveLength(1)
  })
  it('preserves declared envelope presentation without scanning nested data', () => {
    expect(projectToolOutput('page_screenshot',envelope({image},[image,{type:'text',text:'caption'}]),'fallback'))
      .toEqual({text:'',output:[image,{type:'text',text:'caption'}],isError:false})
    expect(isOutputPart({...image,data:'not an image'})).toBe(false)
    expect(isOutputPart({...image,mimeType:'text/html'})).toBe(false)
  })
  it('publishes a schema for both successful and partially failed execution results', () => {
    const validate = createSchemaValidator(CODE_RUN_RESULT_SCHEMA,'RunResult')
    for(const result of [
      {ok:true,value:5,output:[image]}, {ok:false,error:{code:'FAILED',message:'failed',toolName:'read'},output:[image]},
    ]) expect(()=>assertSchemaValue(validate,result,'result')).not.toThrow()
    expect(()=>assertSchemaValue(validate,{ok:true,value:5,output:[],extra:true},'result')).toThrow()
    expect(()=>assertSchemaValue(validate,{ok:false,output:[]},'result')).toThrow()
  })
})
