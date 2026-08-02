import { Loader, Stats } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { Experience } from "./components/Experience";
import { CameraWidget } from "./components/CameraWidget.jsx";

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function App() {
    return (
        <>
            <CameraWidget />
            <Loader />
            {/*
              dpr={[1, 1.5]} limits rendering to a max of 1.5x pixel density (standard HD).
              gl={{ antialias: false }} stops the GPU from smoothing edges. On dense phone screens,
              you cannot see jagged edges anyway, so doing this saves a massive amount of processing power.
            */}
            <Canvas
                shadows={!isMobile} // Turn off shadows completely on phones
                camera={{ position: [0.25, 0.25, 2], fov: 30 }}
                dpr={isMobile ? 1 : [1, 1.5]} // Force 1x pixel density on phones
                gl={{ antialias: false, powerPreference: "high-performance" }}
            >
                <color attach="background" args={["#333"]} />
                <fog attach="fog" args={["#333", 10, 20]} />
                <Stats />
                <Suspense>
                    <Experience />
                </Suspense>
            </Canvas>
        </>
    );
}

export default App;