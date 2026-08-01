import { CameraControls, Environment, Gltf } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useRef } from "react";
import {useControls} from "leva";
import {VRMavatar} from "./vrmAvatar.jsx";

export const Experience = () => {
    const controls = useRef();

    const { avatar } = useControls("VRM", {
        avatar: {
            value: "8087383217573817818.vrm",
            options: [
                "8087383217573817818.vrm",
                "262410318834873893.vrm",
                "3859814441197244330.vrm"
            ],
        },
    });

    return (
        <>
            <CameraControls
                ref={controls}
                maxPolarAngle={Math.PI / 2}
                minDistance={1}
                maxDistance={10}
            />
            <Environment preset="sunset" />
            <directionalLight intensity={2} position={[10, 10, 5]} />
            <directionalLight intensity={1} position={[-10, 10, 5]} />
            <group position-y={-1.25}>
                <VRMavatar avatar={avatar} />
            </group>
            <EffectComposer>
                <Bloom mipmapBlur intensity={0.7} />
            </EffectComposer>
        </>
    );
};