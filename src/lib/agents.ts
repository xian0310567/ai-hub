export const AGENT_INFO: Record<string, {
  name: string; role: string; rank: string; color: string; heartbeat: string; workspace: string;
}> = {
  zesty_claw_bot: { name:'클로 🐾', role:'CEO · 전략 총괄',         rank:'⭐⭐ CEO',       color:'#f59e0b', heartbeat:'1h',      workspace:'workspace-zesty'    },
  cofounder:      { name:'포지 🔨', role:'Dev Lead · MOA 개발',      rank:'⭐★ Director', color:'#3b82f6', heartbeat:'disabled', workspace:'workspace-cofounder'},
  insta:          { name:'유나 ✨', role:'Content · 인스타 자동화',   rank:'⭐★ Director', color:'#ec4899', heartbeat:'disabled', workspace:'workspace-insta'    },
  quant:          { name:'퀀트 📈', role:'BTC 자동매매',              rank:'⭐★ Director', color:'#10b981', heartbeat:'disabled', workspace:'workspace-quant'    },
  'quant-kr':     { name:'코스모 📊', role:'코스닥/코스피',           rank:'⭐★ Director', color:'#10b981', heartbeat:'disabled', workspace:'workspace-quant-kr' },
};
