export async function api<T>(path:string,method='GET',body?:unknown,requestKey?:string):Promise<T>{
  const res=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(requestKey?{'Idempotency-Key':requestKey}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data:unknown=await res.json();if(!res.ok)throw new Error(typeof data==='object'&&data&&'message'in data?String(data.message):'请求失败，请稍后再试');return data as T;
}
export const message=(e:unknown)=>e instanceof Error?e.message:'操作失败，请稍后重试';
