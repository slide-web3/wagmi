export type Request = (request: {
  method: string
  params?: Array<any>
}) => Promise<any>

export type SendReturnResult = { result: any }
export type SendReturn = any
