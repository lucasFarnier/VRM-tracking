import { Camera } from "@mediapipe/camera_utils";
import { Holistic } from "@mediapipe/holistic";
import { useEffect, useRef, useState } from "react";
import { useVideoRecognition } from "../hooks/useVideoRecognition";

// --- MOBILE DETECTION (computed once at module load) ---
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Module-level guard against React 18 StrictMode's dev-only double-invoke
// of effects (mount -> cleanup -> mount). The old guard checked the Zustand
// store's `videoElement`, but the cleanup function resets that to null
// *before* the second mount runs, so it never actually blocked anything --
// a second Holistic/WASM instance got constructed every time, which is what
// caused the "Cannot read properties of undefined" / EEXIST / WASM abort
// crash and the resulting "no tracking at all".
//
// This flag lives outside the component/module render cycle entirely, so
// it survives StrictMode's synthetic unmount+remount and correctly prevents
// a second Holistic instance from ever being constructed while one is
// already alive.
let holisticInstanceActive = false;

export const CameraWidget = () => {
    // `visible` now only controls whether the preview UI is shown/hidden.
    // It no longer starts/stops the camera or Mediapipe pipeline — those
    // run continuously from mount to unmount.
    const [visible, setVisible] = useState(false);
    const videoElement = useRef();
    const setVideoElement = useVideoRecognition((state) => state.setVideoElement);

    // Used to skip frames on mobile (every 3rd frame is sent to Mediapipe)
    const frameCount = useRef(0);

    const holisticRef = useRef(null);
    const cameraRef = useRef(null);

    // Camera + Holistic are set up once and run for the lifetime of the
    // component — webcam stays active and tracking keeps running whether
    // or not the preview is shown. Only torn down on unmount.
    useEffect(() => {
        if (holisticInstanceActive) {
            return;
        }
        holisticInstanceActive = true;

        setVideoElement(videoElement.current);

        const holistic = new Holistic({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`;
            },
        });
        holistic.setOptions({
            modelComplexity: 0,
            smoothLandmarks: false,
            minDetectionConfidence: 0.65,
            minTrackingConfidence: 0.65,
            refineFaceLandmarks: !isMobile,
        });
        holistic.onResults((results) => {
            useVideoRecognition.getState().resultsCallback?.(results);
        });
        holisticRef.current = holistic;

        const camera = new Camera(videoElement.current, {
            onFrame: async () => {
                frameCount.current++;
                if (isMobile && frameCount.current % 3 !== 0) return;
                await holistic.send({ image: videoElement.current });
            },
            width: isMobile ? 320 : 640,
            height: isMobile ? 240 : 480,
        });
        cameraRef.current = camera;
        camera.start();

        return () => {
            cameraRef.current?.stop();
            cameraRef.current = null;
            holisticRef.current?.close();
            holisticRef.current = null;
            setVideoElement(null);
            holisticInstanceActive = false;
        };
    }, []);

    return (
        <>
            <button
                onClick={() => setVisible((prev) => !prev)}
                className={`fixed bottom-4 right-4 cursor-pointer ${
                    visible
                        ? "bg-red-500 hover:bg-red-700"
                        : "bg-indigo-400 hover:bg-indigo-700"
                } transition-colors duration-200 flex items-center justify-center z-20 p-4 rounded-full text-white drop-shadow-sm`}
            >
                {!visible ? (
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                        className="size-6"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                        />
                    </svg>
                ) : (
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                        className="size-6"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 9.091L16.5 19.5m-1.409-1.409c.407-.407.659-.97.659-1.591v-9a2.25 2.25 0 0 0-2.25-2.25h-9c-.621 0-1.184.252-1.591.659m12.182 12.182L2.909 5.909M1.5 4.5l1.409 1.409"
                        />
                    </svg>
                )}
            </button>
            <div
                className={`absolute z-[999999] bottom-24 right-4 w-[320px] h-[240px] rounded-[20px] overflow-hidden ${
                    !visible ? "hidden" : ""
                }`}
                width={640}
                height={480}
            >
                <video
                    ref={videoElement}
                    className="absolute z-0 w-full h-full top-0 left-0"
                />
            </div>
        </>
    );
};