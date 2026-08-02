import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Pose } from "kalidokit";
import { useControls } from "leva";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

const tmpQuat  = new Quaternion();
const tmpEuler = new Euler();
const tmpMat   = new Matrix4();

// Single consistent MediaPipe → Three.js conversion used everywhere.
// Flip Y (MP Y-down → Three Y-up) and Z (MP toward camera → Three away).
// The scene's rotation-y=PI handles left/right mirroring automatically.
const mpToThree = (l) => new Vector3(l.x, -l.y, -l.z);

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

    const rotateBone = (boneName, value, slerpFactor, flip = { x: 1, y: 1, z: 1 }) => {
        const bone = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) return;
        tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
        tmpQuat.setFromEuler(tmpEuler);
        bone.quaternion.slerp(tmpQuat, slerpFactor);
    };

    // Standard directional FK — rotates bone to point startLm → endLm.
    // Used for fingers where the bone chain follows the landmark chain exactly.
    const applyDirectFK = (boneName, startLm, endLm, slerpFactor, maxAngle = Infinity) => {
        if (!startLm || !endLm) return;
        const bone = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) return;

        let restDir;
        if (bone.children.length > 0) {
            restDir = bone.children[0].position.clone().normalize();
        } else {
            restDir = bone.position.clone().normalize();
        }
        if (restDir.lengthSq() < 0.001) return;

        const targetWorldDir = new Vector3()
            .subVectors(mpToThree(endLm), mpToThree(startLm))
            .normalize();
        if (targetWorldDir.lengthSq() < 0.001) return;

        const parentWorldQuat = new Quaternion();
        if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuat);
        const targetLocalDir = targetWorldDir.clone()
            .applyQuaternion(parentWorldQuat.clone().invert());

        const rotationQuat = new Quaternion().setFromUnitVectors(restDir, targetLocalDir);

        // --- ANTI-COLLAPSE SAFEGUARD ---
        if (maxAngle !== Infinity) {
            const identityQ = new Quaternion();
            const currentAngle = rotationQuat.angleTo(identityQ);
            // If the joint tries to bend further than anatomically possible, scale it back
            if (currentAngle > maxAngle) {
                rotationQuat.slerpQuaternions(identityQ, rotationQuat, maxAngle / currentAngle);
            }
        }
        // -------------------------------

        bone.quaternion.slerp(rotationQuat, slerpFactor);
    };

    // Arm FK with shoulder-relative direction.
    //
    // Why arms spread too wide:
    // applyDirectFK computes bone direction from two absolute landmark
    // positions. For fingers this is fine — each finger bone sits right
    // at its start landmark. But arm bones don't sit at the shoulder
    // landmark position; they sit at the VRM skeleton's shoulder which
    // may be a different width than the person's shoulders in the video.
    //
    // More importantly: MediaPipe poseLandmarks are in normalised image
    // space (0–1 across the frame width). When both hands are raised
    // toward center, the shoulder→elbow vector still points outward in
    // image space because the shoulder landmark is at the edge of the
    // torso. This produces a "too wide" appearance.
    //
    // Fix: compute the direction RELATIVE to the shoulder landmark, not
    // in absolute image space. This makes the arm direction independent
    // of where the shoulder sits in the frame, and naturally brings the
    // arms inward when hands approach center.
    const applyArmFK = (upperName, lowerName, shoulderLm, elbowLm, wristLm, slerpFactor) => {
        if (!shoulderLm || !elbowLm || !wristLm) return;

        const shoulder = mpToThree(shoulderLm);
        const elbow    = mpToThree(elbowLm);
        const wrist    = mpToThree(wristLm);

        // Direction from shoulder to elbow (upper arm orientation)
        const upperDir = new Vector3().subVectors(elbow, shoulder).normalize();
        // Direction from elbow to wrist (lower arm orientation)
        const lowerDir = new Vector3().subVectors(wrist, elbow).normalize();

        // Shoulder inward bias — pulls the upper arm X component toward 0
        // (toward body center) by this fraction. 0 = no change, 1 = fully
        // collapsed to center. 0.3 compensates for MediaPipe's tendency to
        // read shoulders as wider than the VRM skeleton expects.
        // Adjust this value if arms still splay (increase) or pull in too
        // far (decrease).
        const SHOULDER_BIAS = 0.5;
        upperDir.x *= (1 - SHOULDER_BIAS);
        upperDir.normalize();

        const upperBone = userData.vrm?.humanoid.getNormalizedBoneNode(upperName);
        const lowerBone = userData.vrm?.humanoid.getNormalizedBoneNode(lowerName);
        if (!upperBone || !lowerBone) return;

        // Upper arm: rotate its rest direction to match upperDir
        const upperRestDir = upperBone.children[0]?.position.clone().normalize() ?? new Vector3(0, -1, 0);
        const upperParentQ = new Quaternion();
        if (upperBone.parent) upperBone.parent.getWorldQuaternion(upperParentQ);
        const upperLocalDir = upperDir.clone().applyQuaternion(upperParentQ.clone().invert());
        upperBone.quaternion.slerp(
            new Quaternion().setFromUnitVectors(upperRestDir, upperLocalDir),
            slerpFactor
        );

        // Lower arm: direction is relative to where the upper arm now points.
        // We must use the upper bone's CURRENT world quaternion (after the
        // slerp above hasn't fully applied yet, but close enough for 60fps).
        const lowerRestDir = lowerBone.children[0]?.position.clone().normalize() ?? new Vector3(0, -1, 0);
        const lowerParentQ = new Quaternion();
        upperBone.getWorldQuaternion(lowerParentQ);
        const lowerLocalDir = lowerDir.clone().applyQuaternion(lowerParentQ.clone().invert());
        lowerBone.quaternion.slerp(
            new Quaternion().setFromUnitVectors(lowerRestDir, lowerLocalDir),
            slerpFactor
        );
    };

    // Full 3-axis wrist orientation from palm plane landmarks.
    const applyWristOrientation = (boneName, lowerArmName, landmarks, isRight, slerpFactor) => {
        if (!landmarks || landmarks.length < 21) return;
        const bone     = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        const lowerArm = userData.vrm?.humanoid.getNormalizedBoneNode(lowerArmName);
        if (!bone || !lowerArm) return;

        const wrist    = mpToThree(landmarks[0]);
        const indexMcp = mpToThree(landmarks[5]);
        const pinkyMcp = mpToThree(landmarks[17]);

        const fingerVec = new Vector3().subVectors(indexMcp, wrist).normalize();
        const acrossVec = new Vector3().subVectors(pinkyMcp, indexMcp).normalize();

        let palmNormal;
        if (isRight) {
            palmNormal = new Vector3().crossVectors(fingerVec, acrossVec).normalize().negate();
        } else {
            palmNormal = new Vector3().crossVectors(fingerVec, acrossVec).normalize();
        }

        let basisX = isRight ? fingerVec.clone() : fingerVec.clone().negate();
        const basisY = palmNormal.clone();
        const basisZ = new Vector3().crossVectors(basisX, basisY).normalize();
        basisX = new Vector3().crossVectors(basisY, basisZ).normalize();

        tmpMat.makeBasis(basisX, basisY, basisZ);
        const worldQuat = new Quaternion().setFromRotationMatrix(tmpMat);

        const lowerArmWorldQuat = new Quaternion();
        lowerArm.getWorldQuaternion(lowerArmWorldQuat);
        bone.quaternion.slerp(
            lowerArmWorldQuat.clone().invert().multiply(worldQuat),
            slerpFactor
        );
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
            rotateBone("neck", riggedFace.current.head, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });
        }
        if (riggedPose.current) {
            rotateBone("chest", riggedPose.current.Spine, delta * 5, { x: 0.3, y: 0.3, z: 0.3 });
            rotateBone("spine", riggedPose.current.Spine, delta * 5, { x: 0.3, y: 0.3, z: 0.3 });
            rotateBone("hips",  riggedPose.current.Hips.rotation, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });
        }

        const raw = rawResults.current;
        if (!raw) { vrm.update(delta); return; }

        // Arms: use shoulder-relative FK so hands meeting at center
        // doesn't push them apart
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

            // depending on how tight you want the fist to be able to clench.
            const maxBend = 3;

            applyDirectFK(`${prefix}ThumbMetacarpal`,      lms[1],  lms[2],  speed, maxBend);
            applyDirectFK(`${prefix}ThumbProximal`,    lms[2],  lms[3],  speed, maxBend);
            applyDirectFK(`${prefix}ThumbDistal`,        lms[3],  lms[4],  speed, maxBend);

            applyDirectFK(`${prefix}IndexProximal`,      lms[5],  lms[6],  speed, maxBend);
            applyDirectFK(`${prefix}IndexIntermediate`,  lms[6],  lms[7],  speed, maxBend);
            applyDirectFK(`${prefix}IndexDistal`,        lms[7],  lms[8],  speed, maxBend);

            applyDirectFK(`${prefix}MiddleProximal`,     lms[9],  lms[10], speed, maxBend);
            applyDirectFK(`${prefix}MiddleIntermediate`, lms[10], lms[11], speed, maxBend);
            applyDirectFK(`${prefix}MiddleDistal`,       lms[11], lms[12], speed, maxBend);

            applyDirectFK(`${prefix}RingProximal`,       lms[13], lms[14], speed, maxBend);
            applyDirectFK(`${prefix}RingIntermediate`,   lms[14], lms[15], speed, maxBend);
            applyDirectFK(`${prefix}RingDistal`,         lms[15], lms[16], speed, maxBend);

            applyDirectFK(`${prefix}LittleProximal`,     lms[17], lms[18], speed, maxBend);
            applyDirectFK(`${prefix}LittleIntermediate`, lms[18], lms[19], speed, maxBend);
            applyDirectFK(`${prefix}LittleDistal`,       lms[19], lms[20], speed, maxBend);
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