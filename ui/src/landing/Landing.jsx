import { useEffect, useRef } from "react";
import "./landing.css";
import { clamp, useScrollFrame } from "./hooks.js";
import Nav from "./Nav.jsx";
import Hero from "./Hero.jsx";
import RingStory from "./RingStory.jsx";
import Ticker from "./Ticker.jsx";
import Requirements from "./Requirements.jsx";
import Playground from "./Playground.jsx";
import Phases from "./Phases.jsx";
import Quickstart from "./Quickstart.jsx";
import Footer from "./Footer.jsx";

export default function Landing() {
  const washRef = useRef(null);
  const progressRef = useRef(null);
  const lastP = useRef(-1);

  // Whole-page progress. The background wash warms toward furnace yellow as
  // the reader goes down, and a hairline at the top fills. Written only on
  // the two elements that read it, so no other style is recalculated.
  useScrollFrame((frame) => {
    const max = document.documentElement.scrollHeight - frame.vh;
    const p = Math.round(clamp(max > 0 ? frame.y / max : 0) * 1000) / 1000;
    if (p === lastP.current) return undefined;
    lastP.current = p;
    return () => {
      washRef.current?.style.setProperty("--page-p", String(p));
      progressRef.current?.style.setProperty("--page-p", String(p));
    };
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
      <div className="ln-wash" ref={washRef} aria-hidden="true" />
      <span className="ln-nav-progress" ref={progressRef} aria-hidden="true" />
      <a className="ln-skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main" tabIndex={-1}>
        <Hero />
        <RingStory />
        <Ticker />
        <Requirements />
        <Playground />
        <Phases />
        <Quickstart />
      </main>
      <Footer />
    </div>
  );
}
