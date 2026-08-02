import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Pose } from "kalidokit";
import { useControls } from "leva";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

// --- MEMORY OPTIMIZATION: GLOBAL TEMPORARY VARIABLES ---
// We reuse these every frame to prevent Garbage Collection lag.
const tmpEuler = new Euler();
const tmpMat   = new Matrix4();
const tmpV1 = new Vector3();
const tmpV2 = new Vector3();
const tmpV3 = new Vector3();
const tmpV4 = new Vector3();
const tmpQ1 = new Quaternion();
const tmpQ2 = new Quaternion();
const identityQ = new Quaternion(); // Always stays 0,0,0,1

// Re-uses a target Vector3 instead of creating a new one
const applyMpToThree = (l, target) => target.set(l.x, -l.y, -l.z);

export const VRMavatar = ({ avatar, ...props }) => {
    const { scene, userData } = useGLTF(`models/${avatar}`, undefined, undefined, (loader) => {
        loader.register((parser) => new VRMLoaderPlugin(parser));
    });

    const assetA = useFBX("models/animations/Swing Dancing.fbx");
    const assetB = useFBX("models/animations/Thriller Part 2.fbx");
    const assetC = useFBX("models/animations/Breathing Idle.fbx");
    const currentVrm = userData.vrm;

    const clipA = useMemo(() => { const c = remapMixamoAnimationToVrm(currentVrm, assetA); c.name = "Swing Dancing";   return c; }, [assetA, currentVrm]);
    const clipB = useMemo(() => { const c = remapMixamoAnimationToVrm(currentVrm, assetB); c.name = "Thriller Part 2"; return c; }, [assetB, currentVrm]);
    const clipC = useMemo(() => { const c = remapMixamoAnimationToVrm(currentVrm, assetC); c.name = "Idle";            return c; }, [assetC, currentVrm]);

    const { actions } = useAnimations([clipA, clipB, clipC], currentVrm?.scene);

    useEffect(() => {
        if (!userData?.vrm) return;
        const vrm = userData.vrm;
        VRMUtils.removeUnnecessaryVertices(scene);
        VRMUtils.combineSkeletons(scene);
        VRMUtils.combineMorphs(vrm);
        vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
    }, [scene, userData]);

    const setResultsCallback = useVideoRecognition((s) => s.setResultsCallback);
    const videoElement       = useVideoRecognition((s) => s.videoElement);

    const rawResults = useRef();
    const riggedFace = useRef();
    const riggedPose = useRef();

    const resultsCallback = useCallback((results) => {
        if (!videoElement || !currentVrm) return;
        rawResults.current = results;
        if (results.faceLandmarks) {
            riggedFace.current = Face.solve(results.faceLandmarks, {
                runtime: "mediapipe", video: videoElement,
                imageSize: { width: 640, height: 480 },
                smoothBlink: false, blinkSettings: [0.25, 0.75],
            });
        }
        if (results.za && results.poseLandmarks) {
            riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
                runtime: "mediapipe", video: videoElement,
            });
        }
    }, [videoElement, currentVrm]);

    useEffect(() => { setResultsCallback(resultsCallback); }, [resultsCallback, setResultsCallback]);

    const { angry, sad, happy, animation } = useControls("vrm", {
        angry: { value: 0, min: 0, max: 1 },
        sad:   { value: 0, min: 0, max: 1 },
        happy: { value: 0, min: 0, max: 1 },
        animation: { options: ["None", "Idle", "Swing Dancing", "Thriller Part 2"], value: "Idle" },
    });

    useEffect(() => {
        if (animation === "None" || !actions) return;
        actions[animation]?.play();
        return () => { actions[animation]?.stop(); };
    }, [actions, animation]);

    // Avoid object literal {x,y,z} allocation in the signature
    const rotateBone = (boneName, value, slerpFactor, flipX = 1, flipY = 1, flipZ = 1) => {
        const bone = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) return;
        tmpEuler.set(value.x * flipX, value.y * flipY, value.z * flipZ);
        tmpQ1.setFromEuler(tmpEuler);
        bone.quaternion.slerp(tmpQ1, slerpFactor);
    };

    const applyDirectFK = (boneName, startLm, endLm, slerpFactor, maxAngle = Infinity) => {
        if (!startLm || !endLm) return;
        const bone = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) return;

        let restDir = tmpV1;
        if (bone.children.length > 0) {
            restDir.copy(bone.children[0].position).normalize();
        } else {
            restDir.copy(bone.position).normalize();
        }
        if (restDir.lengthSq() < 0.001) return;

        applyMpToThree(startLm, tmpV2);
        applyMpToThree(endLm, tmpV3);

        const targetLocalDir = tmpV4.subVectors(tmpV3, tmpV2).normalize();
        if (targetLocalDir.lengthSq() < 0.001) return;

        tmpQ1.identity();
        if (bone.parent) bone.parent.getWorldQuaternion(tmpQ1);

        targetLocalDir.applyQuaternion(tmpQ1.invert());
        tmpQ2.setFromUnitVectors(restDir, targetLocalDir);

        if (maxAngle !== Infinity) {
            const currentAngle = tmpQ2.angleTo(identityQ);
            if (currentAngle > maxAngle) {
                tmpQ2.slerpQuaternions(identityQ, tmpQ2, maxAngle / currentAngle);
            }
        }

        bone.quaternion.slerp(tmpQ2, slerpFactor);
    };

    const applyArmFK = (upperName, lowerName, shoulderLm, elbowLm, wristLm, slerpFactor) => {
        if (!shoulderLm || !elbowLm || !wristLm) return;
        const upperBone = userData.vrm?.humanoid.getNormalizedBoneNode(upperName);
        const lowerBone = userData.vrm?.humanoid.getNormalizedBoneNode(lowerName);
        if (!upperBone || !lowerBone) return;

        applyMpToThree(shoulderLm, tmpV1);
        applyMpToThree(elbowLm, tmpV2);
        applyMpToThree(wristLm, tmpV3);

        const upperDir = tmpV4.subVectors(tmpV2, tmpV1).normalize();

        // Re-use tmpV1 since we are done with the shoulder
        const lowerDir = tmpV1.subVectors(tmpV3, tmpV2).normalize();

        const SHOULDER_BIAS = 0.7;
        upperDir.x *= (1 - SHOULDER_BIAS);
        upperDir.normalize();

        // Upper arm
        let upperRestDir = tmpV2; // Re-use
        if (upperBone.children[0]) upperRestDir.copy(upperBone.children[0].position).normalize();
        else upperRestDir.set(0, -1, 0);

        tmpQ1.identity();
        if (upperBone.parent) upperBone.parent.getWorldQuaternion(tmpQ1);

        const upperLocalDir = upperDir.applyQuaternion(tmpQ1.invert());
        tmpQ2.setFromUnitVectors(upperRestDir, upperLocalDir);
        upperBone.quaternion.slerp(tmpQ2, slerpFactor);

        // Lower arm
        let lowerRestDir = tmpV2; // Re-use
        if (lowerBone.children[0]) lowerRestDir.copy(lowerBone.children[0].position).normalize();
        else lowerRestDir.set(0, -1, 0);

        tmpQ1.identity();
        upperBone.getWorldQuaternion(tmpQ1);

        const lowerLocalDir = lowerDir.applyQuaternion(tmpQ1.invert());
        tmpQ2.setFromUnitVectors(lowerRestDir, lowerLocalDir);
        lowerBone.quaternion.slerp(tmpQ2, slerpFactor);
    };

    const applyWristOrientation = (boneName, lowerArmName, landmarks, isRight, slerpFactor) => {
        if (!landmarks || landmarks.length < 21) return;
        const bone     = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        const lowerArm = userData.vrm?.humanoid.getNormalizedBoneNode(lowerArmName);
        if (!bone || !lowerArm) return;

        applyMpToThree(landmarks[0], tmpV1);
        applyMpToThree(landmarks[5], tmpV2);
        applyMpToThree(landmarks[17], tmpV3);

        const fingerVec = tmpV4.subVectors(tmpV2, tmpV1).normalize();
        const acrossVec = tmpV1.subVectors(tmpV3, tmpV2).normalize();

        const palmNormal = tmpV2.crossVectors(fingerVec, acrossVec).normalize();
        if (isRight) palmNormal.negate();

        const basisX = tmpV3.copy(fingerVec);
        if (!isRight) basisX.negate();

        const basisY = palmNormal;
        const basisZ = tmpV4.crossVectors(basisX, basisY).normalize(); // Reuse tmpV4
        basisX.crossVectors(basisY, basisZ).normalize();

        tmpMat.makeBasis(basisX, basisY, basisZ);
        tmpQ1.setFromRotationMatrix(tmpMat);

        tmpQ2.identity();
        lowerArm.getWorldQuaternion(tmpQ2);
        tmpQ2.invert().multiply(tmpQ1);

        bone.quaternion.slerp(tmpQ2, slerpFactor);
    };

    const camera = useThree((s) => s.camera);
    const lookAtTarget = useRef();

    useEffect(() => {
        lookAtTarget.current = new Object3D();
        camera.add(lookAtTarget.current);
    }, [camera]);

    useFrame((_, delta) => {
        if (!userData?.vrm) return;
        const vrm = userData.vrm;

        vrm.expressionManager.setValue("angry", angry);
        vrm.expressionManager.setValue("sad",   sad);
        vrm.expressionManager.setValue("happy", happy);

        const speed = delta * 12;

        if (riggedFace.current) {
            const face = riggedFace.current;
            rotateBone("neck", face.head, delta * 5, 0.7, 0.7, 0.7);
            rotateBone("head", face.head, delta * 5, 0.7, 0.7, 0.7);

            vrm.expressionManager.setValue("blinkLeft", Math.max(0, 1 - face.eye.l));
            vrm.expressionManager.setValue("blinkRight", Math.max(0, 1 - face.eye.r));

            vrm.expressionManager.setValue("aa", face.mouth.shape.A);
            vrm.expressionManager.setValue("ee", face.mouth.shape.E);
            vrm.expressionManager.setValue("ih", face.mouth.shape.I);
            vrm.expressionManager.setValue("oh", face.mouth.shape.O);
            vrm.expressionManager.setValue("ou", face.mouth.shape.U);
        }

        if (riggedPose.current) {
            rotateBone("chest", riggedPose.current.Spine, delta * 5, 0.3, 0.3, 0.3);
            rotateBone("spine", riggedPose.current.Spine, delta * 5, 0.3, 0.3, 0.3);
            rotateBone("hips",  riggedPose.current.Hips.rotation, delta * 5, 0.7, 0.7, 0.7);
        }

        const raw = rawResults.current;
        if (!raw) { vrm.update(delta); return; }

        if (raw.poseLandmarks) {
            const pl = raw.poseLandmarks;
            applyArmFK("leftUpperArm",  "leftLowerArm",  pl[11], pl[13], pl[15], speed);
            applyArmFK("rightUpperArm", "rightLowerArm", pl[12], pl[14], pl[16], speed);
        }

        if (raw.leftHandLandmarks) {
            applyWristOrientation("leftHand",  "leftLowerArm",  raw.leftHandLandmarks,  false, speed);
        }
        if (raw.rightHandLandmarks) {
            applyWristOrientation("rightHand", "rightLowerArm", raw.rightHandLandmarks, true,  speed);
        }

        const applyFingers = (prefix, lms) => {
            if (!lms) return;
            const maxBend = 5;

            applyDirectFK(`${prefix}ThumbMetacarpal`, lms[1], lms[2], speed, maxBend);
            applyDirectFK(`${prefix}ThumbProximal`, lms[2], lms[3], speed, maxBend);
            applyDirectFK(`${prefix}ThumbDistal`, lms[3], lms[4], speed, maxBend);

            applyDirectFK(`${prefix}IndexProximal`, lms[5], lms[6], speed, maxBend);
            applyDirectFK(`${prefix}IndexIntermediate`, lms[6], lms[7], speed, maxBend);
            applyDirectFK(`${prefix}IndexDistal`, lms[7], lms[8], speed, maxBend);

            applyDirectFK(`${prefix}MiddleProximal`, lms[9], lms[10], speed, maxBend);
            applyDirectFK(`${prefix}MiddleIntermediate`, lms[10], lms[11], speed, maxBend);
            applyDirectFK(`${prefix}MiddleDistal`, lms[11], lms[12], speed, maxBend);

            applyDirectFK(`${prefix}RingProximal`, lms[13], lms[14], speed, maxBend);
            applyDirectFK(`${prefix}RingIntermediate`, lms[14], lms[15], speed, maxBend);
            applyDirectFK(`${prefix}RingDistal`, lms[15], lms[16], speed, maxBend);

            applyDirectFK(`${prefix}LittleProximal`, lms[17], lms[18], speed, maxBend);
            applyDirectFK(`${prefix}LittleIntermediate`, lms[18], lms[19], speed, maxBend);
            applyDirectFK(`${prefix}LittleDistal`, lms[19], lms[20], speed, maxBend);
        };

        applyFingers("left",  raw.leftHandLandmarks);
        applyFingers("right", raw.rightHandLandmarks);

        vrm.update(delta);
    });

    return (
        <group {...props}>
            <primitive object={scene} rotation-y={avatar ? Math.PI : 0} />
        </group>
    );
};