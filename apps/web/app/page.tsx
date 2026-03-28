'use client';

import Link from 'next/link';
import { Zap, Package, Mail, Check, ArrowRight } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-cyan-600 rounded-lg flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-bold text-white text-sm">Label<span className="text-cyan-400">Flow</span></span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-zinc-400 hover:text-white text-sm transition-colors">Iniciar sesion</Link>
            <Link href="/signup" className="bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">Empezar gratis</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-cyan-600/10 border border-cyan-500/20 rounded-full px-4 py-1.5 mb-8">
            <Zap className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-cyan-400 text-xs font-medium">Automatizacion para e-commerce Uruguay</span>
          </div>
          <h1 className="text-5xl md:text-6xl font-bold text-white leading-tight mb-6">
            Genera etiquetas de DAC<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-400">automaticamente</span> desde Shopify
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Conecta tu tienda y olvidate del trabajo manual. LabelFlow procesa tus pedidos, genera las etiquetas y notifica a tus clientes.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/signup" className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-8 py-3.5 rounded-xl text-sm font-medium transition-all hover:shadow-lg hover:shadow-cyan-600/25">
              Empezar gratis 14 dias <ArrowRight className="w-4 h-4" />
            </Link>
            <a href="#pricing" className="inline-flex items-center gap-2 border border-white/[0.1] text-zinc-300 px-6 py-3.5 rounded-xl text-sm font-medium hover:bg-white/[0.03] transition-colors">Ver planes</a>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-6 border-t border-white/[0.04]">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-white text-center mb-4">Como funciona</h2>
          <p className="text-zinc-500 text-center mb-16">3 pasos y listo.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { step: '01', icon: <Package className="w-6 h-6" />, title: 'Conecta tu tienda', desc: 'Vincula tu Shopify y tu cuenta DAC en minutos.' },
              { step: '02', icon: <Zap className="w-6 h-6" />, title: 'Detecta pedidos', desc: 'LabelFlow detecta pedidos pagados automaticamente.' },
              { step: '03', icon: <Mail className="w-6 h-6" />, title: 'Etiquetas listas', desc: 'Se generan solas y tus clientes reciben su guia.' },
            ].map((item) => (
              <div key={item.step} className="bg-zinc-900/50 border border-white/[0.06] rounded-2xl p-8 text-center">
                <div className="text-[10px] text-cyan-400 font-bold mb-4">{item.step}</div>
                <div className="w-12 h-12 bg-cyan-600/10 rounded-xl flex items-center justify-center mx-auto mb-4 text-cyan-400">{item.icon}</div>
                <h3 className="text-lg font-semibold text-white mb-2">{item.title}</h3>
                <p className="text-sm text-zinc-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 px-6 border-t border-white/[0.04]">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-white text-center mb-16">Planes</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { name: 'Starter', price: 15, limit: '100 etiquetas/mes', features: ['Procesamiento auto', 'Email al cliente', 'Dashboard'] },
              { name: 'Growth', price: 35, limit: '500 etiquetas/mes', popular: true, features: ['Todo de Starter', 'Webhooks', 'API + MCP', 'Soporte prioritario'] },
              { name: 'Pro', price: 69, limit: 'Ilimitado', features: ['Todo de Growth', 'Soporte dedicado', 'Custom rules'] },
            ].map((plan) => (
              <div key={plan.name} className={`bg-zinc-900/50 border rounded-2xl p-8 relative ${'popular' in plan && plan.popular ? 'border-cyan-500/30 scale-105' : 'border-white/[0.06]'}`}>
                {'popular' in plan && plan.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-cyan-600 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">Popular</div>}
                <h3 className="text-xl font-bold text-white mb-1">{plan.name}</h3>
                <p className="text-xs text-zinc-500 mb-4">{plan.limit}</p>
                <p className="text-4xl font-bold text-white mb-6">${plan.price}<span className="text-sm font-normal text-zinc-500">/mes</span></p>
                <ul className="space-y-2.5 mb-8">
                  {plan.features.map((f) => <li key={f} className="flex items-center gap-2 text-sm text-zinc-400"><Check className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" /> {f}</li>)}
                </ul>
                <Link href="/signup" className={`block text-center py-3 rounded-xl text-sm font-medium transition-colors ${'popular' in plan && plan.popular ? 'bg-cyan-600 hover:bg-cyan-500 text-white' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'}`}>Empezar</Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 px-6 border-t border-white/[0.04]">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-white text-center mb-12">FAQ</h2>
          {[
            { q: 'Necesito conocimientos tecnicos?', a: 'No. Solo tu tienda Shopify y una cuenta en dac.com.uy.' },
            { q: 'Como genera etiquetas si DAC no tiene API?', a: 'Usamos automatizacion de browser, como si un operario lo hiciera.' },
            { q: 'Mis clientes reciben notificacion?', a: 'Si. Email con numero de guia y link de rastreo.' },
            { q: 'Puedo usar mas de una tienda?', a: 'Si, con el plan Pro.' },
            { q: 'Que pasa si DAC cambia su web?', a: 'Actualizamos los selectores automaticamente.' },
          ].map((faq, i) => (
            <div key={i} className="border-b border-white/[0.06] py-5">
              <h3 className="text-sm font-semibold text-white mb-2">{faq.q}</h3>
              <p className="text-sm text-zinc-500">{faq.a}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="py-12 px-6 border-t border-white/[0.04]">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-zinc-600 text-sm">LabelFlow &mdash; Automatizacion de envios Uruguay</p>
          <div className="flex items-center gap-6">
            <Link href="/terminos" className="text-zinc-600 hover:text-zinc-400 text-sm transition-colors">
              Terminos de Servicio
            </Link>
            <Link href="/privacidad" className="text-zinc-600 hover:text-zinc-400 text-sm transition-colors">
              Politica de Privacidad
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
