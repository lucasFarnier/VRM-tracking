import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Pose, Hand } from "kalidokit"; // Brought Hand back
import { useControls } from "leva";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import { lerp } from "three/src/math/MathUtils.js";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

const tmpVec3 = new Vector3();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();

export const VRMavatar = ({ avatar, ...props }) => {
    const { scene, userData } = useGLTF(`models/${avatar}`, undefined, undefined, (loader) => {
        loader.register((parser) => {
            return new VRMLoaderPlugin(parser);
        });
    });

    const assetA = useFBX("models/animations/Swing Dancing.fbx");
    const assetB = useFBX("models/animations/Thriller Part 2.fbx");
    const assetC = useFBX("models/animations/Breathing Idle.fbx");
    const currentVrm = userData.vrm;

    const animationClipA = useMemo(() => { const clip = remapMixamoAnimationToVrm(currentVrm, assetA); clip.name = "Swing Dancing"; return clip; }, [assetA, currentVrm]);
    const animationClipB = useMemo(() => { const clip = remapMixamoAnimationToVrm(currentVrm, assetB); clip.name = "Thriller Part 2"; return clip; }, [assetB, currentVrm]);
    const animationClipC = useMemo(() => { const clip = remapMixamoAnimationToVrm(currentVrm, assetC); clip.name = "Idle"; return clip; }, [assetC, currentVrm]);

    const { actions } = useAnimations([animationClipA, animationClipB, animationClipC], currentVrm?.scene);

    useEffect(() => {
        if (!userData?.vrm) return;
        const vrm = userData.vrm;
        VRMUtils.removeUnnecessaryVertices(scene);
        VRMUtils.combineSkeletons(scene);
        VRMUtils.combineMorphs(vrm);
        vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
    }, [scene, userData]);

    const setResultsCallback = useVideoRecognition((state) => state.setResultsCallback);
    const videoElement = useVideoRecognition((state) => state.videoElement);
    const rawResults = useRef();

    // Kalidokit Refs
    const riggedFace = useRef();
    const riggedPose = useRef();
    const riggedLeftHand = useRef();
    const riggedRightHand = useRef();

    const resultsCallback = useCallback((results) => {
        if (!videoElement || !currentVrm) return;
        rawResults.current = results;

        if (results.faceLandmarks) {
            riggedFace.current = Face.solve(results.faceLandmarks, { runtime: "mediapipe", video: videoElement, imageSizes: { width: 640, height: 480 }, smoothBlink: false, blinkSettings: [0.25, 0.75] });
        }
        if (results.za && results.poseLandmarks) {
            riggedPose.current = Pose.solve(results.za, results.poseLandmarks, { runtime: "mediapipe", video: videoElement });
        }

        // FIXED BUG: You were passing left landmarks to the right hand in your original code!
        if (results.leftHandLandmarks) {
            riggedLeftHand.current = Hand.solve(results.leftHandLandmarks, "Left");
        }
        if (results.rightHandLandmarks) {
            riggedRightHand.current = Hand.solve(results.rightHandLandmarks, "Right");
        }
    }, [videoElement, currentVrm]);

    useEffect(() => { setResultsCallback(resultsCallback); }, [resultsCallback, setResultsCallback]);

    const { angry, sad, happy, animation } = useControls("vrm", { angry: { value: 0, min: 0, max: 1 }, sad: { value: 0, min: 0, max: 1 }, happy: { value: 0, min: 0, max: 1 }, animation: { options: ["None", "Idle", "Swing Dancing", "Thriller Part 2"], value: "Idle" } });

    useEffect(() => {
        if (animation === "None" || !actions) return;
        actions[animation]?.play();
        return () => { actions[animation]?.stop(); };
    }, [actions, animation]);

    // Used for Kalidokit Rotations
    const rotateBone = (boneName, value, slerpFactor, flip = { x: 1, y: 1, z: 1 }) => {
        const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) return;
        tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
        tmpQuat.setFromEuler(tmpEuler);
        bone.quaternion.slerp(tmpQuat, slerpFactor);
    };

    // Used for Vector Arms & Fingers
    const applyDirectFK = (boneName, startLm, endLm, slerpFactor) => {
        if (!startLm || !endLm) return;
        const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) return;

        let restDir;
        if (bone.children.length > 0) {
            restDir = bone.children[0].position.clone().normalize();
        } else {
            restDir = bone.position.clone().normalize();
        }
        if (restDir.lengthSq() === 0) return;

        const start = new Vector3(startLm.x, -startLm.y, -startLm.z);
        const end = new Vector3(endLm.x, -endLm.y, -endLm.z);
        const targetWorldDir = end.sub(start).normalize();
        if (targetWorldDir.lengthSq() === 0) return;

        const parentWorldQuat = new Quaternion();
        if (bone.parent) {
            bone.parent.getWorldQuaternion(parentWorldQuat);
        }
        const invParentQuat = parentWorldQuat.invert();

        const targetLocalDir = targetWorldDir.applyQuaternion(invParentQuat);
        const rotationQuat = new Quaternion().setFromUnitVectors(restDir, targetLocalDir);
        bone.quaternion.slerp(rotationQuat, slerpFactor);
    };

    useFrame((_, delta) => {
        if (!userData?.vrm) return;
        userData.vrm.expressionManager.setValue("angry", angry);
        userData.vrm.expressionManager.setValue("sad", sad);
        userData.vrm.expressionManager.setValue("happy", happy);

        // --- FACE & BODY (Kalidokit) ---
        if (riggedFace.current) {
            rotateBone("neck", riggedFace.current.head, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });
        }
        if (riggedPose.current) {
            rotateBone("chest", riggedPose.current.Spine, delta * 5, { x: 0.3, y: 0.3, z: 0.3 });
            rotateBone("spine", riggedPose.current.Spine, delta * 5, { x: 0.3, y: 0.3, z: 0.3 });
            rotateBone("hips", riggedPose.current.Hips.rotation, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });
        }

        const raw = rawResults.current;
        if (raw) {
            const speed = delta * 12;

            // --- ARMS (Direct FK - Stops Crossing) ---
            if (raw.poseLandmarks) {
                applyDirectFK("leftUpperArm", raw.poseLandmarks[11], raw.poseLandmarks[13], speed);
                applyDirectFK("leftLowerArm", raw.poseLandmarks[13], raw.poseLandmarks[15], speed);

                applyDirectFK("rightUpperArm", raw.poseLandmarks[12], raw.poseLandmarks[14], speed);
                applyDirectFK("rightLowerArm", raw.poseLandmarks[14], raw.poseLandmarks[16], speed);
            }

            // --- WRISTS (Kalidokit - Fixes Backwards Palm & Roll) ---
            if (riggedLeftHand.current) {
                rotateBone("leftHand", {
                    x: riggedLeftHand.current.LeftWrist.x,
                    y: riggedLeftHand.current.LeftWrist.y,
                    z: riggedLeftHand.current.LeftWrist.z
                }, speed);
            }
            if (riggedRightHand.current) {
                rotateBone("rightHand", {
                    x: riggedRightHand.current.RightWrist.x,
                    y: riggedRightHand.current.RightWrist.y,
                    z: riggedRightHand.current.RightWrist.z
                }, speed);
            }

            // --- FINGERS (Direct FK - Stops Crumpling) ---
            const processFingers = (prefix, lh) => {
                if (!lh) return;
                applyDirectFK(`${prefix}ThumbProximal`, lh[1], lh[2], speed);
                applyDirectFK(`${prefix}ThumbMetacarpal`, lh[2], lh[3], speed);
                applyDirectFK(`${prefix}ThumbDistal`, lh[3], lh[4], speed);
                applyDirectFK(`${prefix}IndexProximal`, lh[5], lh[6], speed);
                applyDirectFK(`${prefix}IndexIntermediate`, lh[6], lh[7], speed);
                applyDirectFK(`${prefix}IndexDistal`, lh[7], lh[8], speed);
                applyDirectFK(`${prefix}MiddleProximal`, lh[9], lh[10], speed);
                applyDirectFK(`${prefix}MiddleIntermediate`, lh[10], lh[11], speed);
                applyDirectFK(`${prefix}MiddleDistal`, lh[11], lh[12], speed);
                applyDirectFK(`${prefix}RingProximal`, lh[13], lh[14], speed);
                applyDirectFK(`${prefix}RingIntermediate`, lh[14], lh[15], speed);
                applyDirectFK(`${prefix}RingDistal`, lh[15], lh[16], speed);
                applyDirectFK(`${prefix}LittleProximal`, lh[17], lh[18], speed);
                applyDirectFK(`${prefix}LittleIntermediate`, lh[18], lh[19], speed);
                applyDirectFK(`${prefix}LittleDistal`, lh[19], lh[20], speed);
            };

            processFingers("left", raw.leftHandLandmarks);
            processFingers("right", raw.rightHandLandmarks);
        }

        userData.vrm.update(delta);
    });

    const camera = useThree((state) => state.camera);
    const lookAtTarget = useRef();

    useEffect(() => {
        lookAtTarget.current = new Object3D();
        camera.add(lookAtTarget.current);
    });

    return (
        <group {...props}>
            <primitive object={scene} rotation-y={avatar ? Math.PI : 0} />
        </group>
    );
}; // works ish