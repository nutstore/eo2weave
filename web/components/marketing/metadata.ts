import type { Metadata } from 'next'
import { copy, isCN } from './content'

const base = isCN ? 'https://weave.eo2suite.cn' : 'https://weave.eo2suite.com'
export function marketingMetadata(path: string, title: string, description: string): Metadata {
  return { title: `${title} · ${copy.brand}`, description, alternates: { canonical: `${base}${path}`, languages: { 'zh-CN': `https://weave.eo2suite.cn${path}`, en: `https://weave.eo2suite.com${path}` } }, openGraph: { title: `${title} · ${copy.brand}`, description, url: `${base}${path}` } }
}
