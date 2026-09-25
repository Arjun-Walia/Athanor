import { useEffect, useRef } from "react";
import "./landing.css";
import { clamp, useScrollFrame } from "./hooks.js";
import Nav from "./Nav.jsx";
import Hero from "./Hero.jsx";
import Manifesto from "./Manifesto.jsx";
import HowItWorks from "./HowItWorks.jsx";
import Numbers from "./Numbers.jsx";
import Ticker from "./Ticker.jsx";
import Breaker from "./Breaker.jsx";
import Playground from "./Playground.jsx";
import Quickstart from "./Quickstart.jsx";
import Footer from "./Footer.jsx";

/*
 * The landing page. One idea per screen, in this order:
 *
 *   hero        what it is, in one line, over a ring that is quietly working
 *   manifesto   three sentences that fill in as you scroll
 *   how         four pinned steps: hash, replicate, detect, heal
 *   numbers     the defaults, counted up
 *   ticker      what the event log sounds like
 *   break       an interactive card: kill, flip, heal, restart
 *   quorum      N, W, R and what they cost
 *   run         three ways to start it, and the desktop installers
 *
 * Everything that moves is driven by CSS from a handful of custom
 * properties that the hooks in hooks.js write. Nothing here is live
 * cluster data; the dashboard at /app is where the real thing lives.
 */
export default function Landing() {
  const progressRef = useRef(null);
  const lastP = useRef(-1);

  // Whole-page progress for the hairline under the nav.
  useScrollFrame((frame) => {
    const max = document.documentElement.scrollHeight - frame.vh;
    const p = Math.round(clamp(max > 0 ? frame.y / max : 0) * 1000) / 1000;
    if (p === lastP.current) return undefined;
    lastP.current = p;
    return () => progressRef.current?.style.setProperty("--page-p", String(p));
  });

  // The page renders on the client, so the browser cannot honour a #section
  // in the address on first load. Do it once the sections exist.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return undefined;
    const raf = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="ln-root">
      <span className="ln-progress" ref={progressRef} aria-hidden="true" />
      <a className="ln-skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main" tabIndex={-1}>
        <Hero />
        <Manifesto />
        <HowItWorks />
        <Numbers />
        <Ticker />
        <Breaker />
        <Playground />
        <Quickstart />
      </main>
      <Footer />
    </div>
  );
}
