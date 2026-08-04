import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Pose } from "kalidokit";
import { useControls } from "leva";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {Euler, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, SphereGeometry, Vector3} from "three";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

// --- MEMORY OPTIMIZATION: GLOBAL TEMPORARY VARIABLES ---
const tmpEuler = new Euler();
const tmpMat = new Matrix4();
const tmpV1 = new Vector3();
const tmpV2 = new Vector3();
const tmpV3 = new Vector3();
const tmpV4 = new Vector3();
const tmpQ1 = new Quaternion();
const tmpQ2 = new Quaternion();
const identityQ = new Quaternion();

// IK scratch
const ikRootPos = new Vector3();
const ikMidPos = new Vector3();
const ikEndPos = new Vector3();
const ikToTarget = new Vector3();
const ikDir = new Vector3();
const ikPoleDir = new Vector3();
const ikBendAxis = new Vector3();
const ikSwingAxis = new Vector3();
const ikRestDirWorld = new Vector3();
const ikParentQuat = new Quaternion();
const ikParentQuatInv = new Quaternion();
const ikAlignQuat = new Quaternion();
const ikSwingQuat = new Quaternion();
const ikBendQuat = new Quaternion();
const ikWorldQuat = new Quaternion();
const ikMidRestDirWorld = new Vector3();
const ikMidTargetDirWorld = new Vector3();
const ikMidAlignQuat = new Quaternion();
const ikTargetLocal = new Vector3();
const ikPoleLocal = new Vector3();
const ikHipsWorldPos = new Vector3();
const ikShoulderAnchorPos = new Vector3();

const applyMpToThree = (l, target) => target.set(l.x, -l.y, -l.z);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// COORDINATE FIXES
// ---------------------------------------------------------------------------
// Most browser webcams are mirrored (like a mirror). If your video element is
// NOT mirrored, set this to false.
const MIRROR_LANDMARKS_X = true;

// If your rig is upside-down after the other fixes, flip this to -1.
const Y_SIGN = -1;

// Elbow bend limits
const MIN_ELBOW_BEND = 0.0;
const MAX_ELBOW_BEND = (150 * Math.PI) / 180;

// Signing-space depth limits (negative = behind body, positive = in front)
const SIGNING_SPACE_Z_MIN = -0.15;
const SIGNING_SPACE_Z_MAX = 0.65;
const ARM_SPAN_SCALE = 0.9;

// Z smoothing
const zSmoothState = {};
const Z_SMOOTHING = 0.65;
const smoothZ = (key, rawZ) => {
    const prev = zSmoothState[key] ?? null;
    const next = prev === null ? rawZ : prev + (rawZ - prev) * (1 - Z_SMOOTHING);
    zSmoothState[key] = next;
    return next;
};


// --- SCALE-BASED FORWARD/BACKWARD DEPTH ESTIMATION ---
// MediaPipe Z is noisy and relative. We use perspective: apparent size ∝ 1/distance.
// Face width (eye-to-eye) is our stable ruler. Hand width (wrist → middle MCP)
// changes reliably as the hand moves toward/away from the camera.

const HAND_BASELINE = { left: null, right: null };
const BASELINE_ALPHA = 0.03; // very slow adaptation so it doesn't chase motion

const getHandScale = (handLms) => {
    if (!handLms || handLms.length < 10) return 0;
    const wrist = handLms[0];
    const middleMCP = handLms[9];
    if (!wrist || !middleMCP) return 0;
    return Math.hypot(wrist.x - middleMCP.x, wrist.y - middleMCP.y);
};

const getFaceScale = (poseLms) => {
    if (!poseLms || poseLms.length < 6) return 0;
    const leftEye = poseLms[2];   // MediaPipe Pose indices
    const rightEye = poseLms[5];
    if (!leftEye || !rightEye) return 0;
    return Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
};

const estimateZFromHandScale = (handLms, poseLms, side, sensitivity = 1.0) => {
    const handSize = getHandScale(handLms);
    const faceSize = getFaceScale(poseLms);
    if (handSize < 0.001 || faceSize < 0.001) return null;

    const ratio = handSize / faceSize;
    const sideKey = side === "left" ? "left" : "right";

    // First-frame init
    if (HAND_BASELINE[sideKey] === null) {
        HAND_BASELINE[sideKey] = ratio;
        return null; // need a few frames to stabilise
    }

    // Slowly adapt baseline only when the ratio is stable (within 20 %).
    // This prevents the baseline from drifting when you hold your hand
    // forward for a long time.
    const deviation = Math.abs(ratio - HAND_BASELINE[sideKey]) / HAND_BASELINE[sideKey];
    if (deviation < 0.2) {
        HAND_BASELINE[sideKey] =
            HAND_BASELINE[sideKey] * (1 - BASELINE_ALPHA) + ratio * BASELINE_ALPHA;
    }

    const baseline = HAND_BASELINE[sideKey];

    // Perspective: size ∝ 1/distance.
    // We treat the baseline depth as Z ≈ 0 (roughly shoulder depth).
    // Positive Z = closer to camera (in front of body).
    const D_REF = 0.5; // metres; tunes how far the hand travels in Z
    let z = D_REF * (1 - baseline / ratio) * sensitivity;

    return clamp(z, SIGNING_SPACE_Z_MIN / ARM_SPAN_SCALE, SIGNING_SPACE_Z_MAX / ARM_SPAN_SCALE);
};


// ---------------------------------------------------------------------------
// REST-DIRECTION AUTO-DETECTION
// VRM normalised humanoid bones almost always point toward their child along
// local Y (usually -Y).  The old hard-coded (1,0,0) / (-1,0,0) assumed local
// X, which is why the shoulder twisted and the arm shot up/behind the head.
// ---------------------------------------------------------------------------
const detectRestDir = (bone, fallback = new Vector3(0, -1, 0)) => {
    if (!bone) return fallback.clone();
    // The next bone in the chain is usually the first child Bone
    const child = bone.children.find((c) => c.isBone) || bone.children[0];
    if (!child) return fallback.clone();
    const dir = child.position.clone().normalize();
    return dir.lengthSq() < 0.001 ? fallback.clone() : dir;
};

// ---------------------------------------------------------------------------
// TWO-BONE IK
// ---------------------------------------------------------------------------
const solveTwoBoneIK = (rootBone, midBone, endBone, targetWorld, poleWorld, slerpFactor, restDir) => {
    if (!rootBone || !midBone || !endBone || !targetWorld) return;

    rootBone.getWorldPosition(ikRootPos);
    midBone.getWorldPosition(ikMidPos);
    endBone.getWorldPosition(ikEndPos);

    const upperLen = ikRootPos.distanceTo(ikMidPos);
    const lowerLen = ikMidPos.distanceTo(ikEndPos);
    const chainLen = upperLen + lowerLen;
    if (chainLen < 1e-5) return;

    ikToTarget.subVectors(targetWorld, ikRootPos);
    let targetDist = ikToTarget.length();
    const maxReach = chainLen * 0.999;
    if (targetDist > maxReach) {
        ikToTarget.setLength(maxReach);
        targetDist = maxReach;
    }
    if (targetDist < 1e-5) return;

    ikDir.copy(ikToTarget).normalize();

    const a = upperLen, b = lowerLen, c = targetDist;
    const cosRoot = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
    const angleRootFromTarget = Math.acos(cosRoot);
    const cosElbow = clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1);
    let elbowBendAngle = Math.PI - Math.acos(cosElbow);
    elbowBendAngle = clamp(elbowBendAngle, MIN_ELBOW_BEND, MAX_ELBOW_BEND);

    ikPoleDir.subVectors(poleWorld ?? ikMidPos, ikRootPos);
    const along = ikPoleDir.dot(ikDir);
    ikBendAxis.copy(ikPoleDir).addScaledVector(ikDir, -along);
    if (ikBendAxis.lengthSq() < 1e-8) {
        if (Math.abs(ikDir.y) < 0.99) ikBendAxis.set(0, 1, 0).cross(ikDir);
        else ikBendAxis.set(1, 0, 0).cross(ikDir);
    }
    ikBendAxis.normalize();
    ikSwingAxis.crossVectors(ikDir, ikBendAxis).normalize();

    // --- Root bone (upper arm) ---
    ikParentQuat.identity();
    if (rootBone.parent) rootBone.parent.getWorldQuaternion(ikParentQuat);
    ikRestDirWorld.copy(restDir).applyQuaternion(ikParentQuat).normalize();

    ikAlignQuat.setFromUnitVectors(ikRestDirWorld, ikDir);
    ikSwingQuat.setFromAxisAngle(ikSwingAxis, angleRootFromTarget);
    ikSwingQuat.multiply(ikAlignQuat);
    ikParentQuatInv.copy(ikParentQuat).invert();
    tmpQ2.copy(ikParentQuatInv).multiply(ikSwingQuat);

    rootBone.quaternion.slerp(tmpQ2, slerpFactor);
    rootBone.updateMatrixWorld(true);

    // --- Mid bone (forearm) ---
    rootBone.getWorldQuaternion(ikWorldQuat);
    ikMidRestDirWorld.copy(restDir).applyQuaternion(ikWorldQuat).normalize();

    ikBendQuat.setFromAxisAngle(ikSwingAxis, -elbowBendAngle);
    ikMidTargetDirWorld.copy(ikMidRestDirWorld).applyQuaternion(ikBendQuat);

    ikMidAlignQuat.setFromUnitVectors(ikMidRestDirWorld, ikMidTargetDirWorld);

    const rootWorldQuatInv = ikWorldQuat.clone().invert();
    const midWorldTarget = ikMidAlignQuat.clone().multiply(ikWorldQuat);
    const midLocalTarget = rootWorldQuatInv.multiply(midWorldTarget);

    midBone.quaternion.slerp(midLocalTarget, slerpFactor);
    midBone.updateMatrixWorld(true);
};

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------
export const VRMavatar = ({ avatar, ...props }) => {
    const { scene, userData } = useGLTF(`models/${avatar}`, undefined, undefined, (loader) => {
        loader.register((parser) => new VRMLoaderPlugin(parser));
    });

    const assetA = useFBX("models/animations/Swing Dancing.fbx");
    const assetB = useFBX("models/animations/Thriller Part 2.fbx");
    const assetC = useFBX("models/animations/Breathing Idle.fbx");
    const currentVrm = userData.vrm;

    const clipA = useMemo(() => { const c = remapMixamoAnimationToVrm(currentVrm, assetA); c.name = "Swing Dancing"; return c; }, [assetA, currentVrm]);
    const clipB = useMemo(() => { const c = remapMixamoAnimationToVrm(currentVrm, assetB); c.name = "Thriller Part 2"; return c; }, [assetB, currentVrm]);
    const clipC = useMemo(() => { const c = remapMixamoAnimationToVrm(currentVrm, assetC); c.name = "Idle"; return c; }, [assetC, currentVrm]);

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
    const videoElement = useVideoRecognition((s) => s.videoElement);

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

    const { angry, sad, happy, animation, showDebug, zSensitivity } = useControls("vrm", {
        angry: { value: 0, min: 0, max: 1 },
        sad: { value: 0, min: 0, max: 1 },
        happy: { value: 0, min: 0, max: 1 },
        animation: { options: ["None", "Idle", "Swing Dancing", "Thriller Part 2"], value: "Idle" },
        showDebug: { value: true, label: "Show IK targets" },
        zSensitivity: { value: -0.6, min: -1, max: 1, step: 0.1, label: "Z depth sensitivity" },
    });

    useEffect(() => {
        if (animation === "None" || !actions) return;
        actions[animation]?.play();
        return () => { actions[animation]?.stop(); };
    }, [actions, animation]);

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

        if (tmpV4.subVectors(tmpV3, tmpV2).lengthSq() < 0.0001) return;
        const targetLocalDir = tmpV4.subVectors(tmpV3, tmpV2).normalize();

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

    // -----------------------------------------------------------------------
    // FIXED landmark → world-target conversion
    // -----------------------------------------------------------------------
    const landmarkToWorldTarget = (lm, shoulderLm, anchorWorldPos, out, smoothKey, zOverride = null) => {
        if (!lm || !shoulderLm) return null;

        let localZ;
        if (zOverride !== null) {
            // Use the scale-based depth estimate (smoothed on its own key)
            localZ = smoothZ(smoothKey + "_scaleZ", zOverride);
        } else {
            // Fall back to MediaPipe's native Z (relative, less accurate)
            const rawDeltaZ = lm.z - shoulderLm.z;
            const smoothedDeltaZ = smoothZ(smoothKey, rawDeltaZ);
            localZ = smoothedDeltaZ-1;
        }
        localZ = clamp(localZ, SIGNING_SPACE_Z_MIN / ARM_SPAN_SCALE, SIGNING_SPACE_Z_MAX / ARM_SPAN_SCALE);

        let localX = lm.x - shoulderLm.x;
        if (MIRROR_LANDMARKS_X) localX = -localX;
        const localY = Y_SIGN * -(lm.y - shoulderLm.y);

        tmpV3.set(localX, localY, localZ);
        out.copy(anchorWorldPos).addScaledVector(tmpV3, ARM_SPAN_SCALE);
        return out;
    };

    const applyArmIK = (upperName, lowerName, handName, shoulderLm, elbowLm, wristLm, handLms, slerpFactor, sideKey, zSensitivity) => {
        if (!shoulderLm || !elbowLm || !wristLm) return;
        const upperBone = userData.vrm?.humanoid.getNormalizedBoneNode(upperName);
        const lowerBone = userData.vrm?.humanoid.getNormalizedBoneNode(lowerName);
        const handBone = userData.vrm?.humanoid.getNormalizedBoneNode(handName);
        if (!upperBone || !lowerBone || !handBone) return;

        const restDir = detectRestDir(upperBone);
        upperBone.getWorldPosition(ikShoulderAnchorPos);

        // Compute scale-based Z override from hand landmarks
        const zOverride = estimateZFromHandScale(
            handLms,
            rawResults.current?.poseLandmarks,
            sideKey,
            zSensitivity
        );

        const target = landmarkToWorldTarget(
            wristLm, shoulderLm, ikShoulderAnchorPos, ikTargetLocal, `${sideKey}Wrist`, zOverride
        );
        const pole = landmarkToWorldTarget(
            elbowLm, shoulderLm, ikShoulderAnchorPos, ikPoleLocal, `${sideKey}Elbow`
        );
        if (!target) return;

        solveTwoBoneIK(upperBone, lowerBone, handBone, target, pole, slerpFactor, restDir);
        return target.clone();
    };

    const applyWristOrientation = (boneName, lowerArmName, landmarks, isRight, slerpFactor) => {
        if (!landmarks || landmarks.length < 21) return;
        const bone = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
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
        const basisZ = tmpV4.crossVectors(basisX, basisY).normalize();
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

    // Debug spheres so you can see the IK targets in the scene
    const debugRef = useRef({ left: null, right: null, leftPole: null, rightPole: null });
    useEffect(() => {
        lookAtTarget.current = new Object3D();
        camera.add(lookAtTarget.current);

        // Create simple debug meshes if they don't exist
        const geo = new SphereGeometry(0.03, 8, 8);
        const mat = new MeshBasicMaterial({ color: 0xff0000, wireframe: true });
        const matPole = new MeshBasicMaterial({ color: 0x00ff00, wireframe: true });

        ["left", "right", "leftPole", "rightPole"].forEach((k) => {
            if (!debugRef.current[k]) {
                debugRef.current[k] = new Mesh(geo, k.includes("Pole") ? matPole : mat);
                debugRef.current[k].visible = false;
                scene.add(debugRef.current[k]);
            }
        });

        return () => {
            ["left", "right", "leftPole", "rightPole"].forEach((k) => {
                if (debugRef.current[k]) {
                    scene.remove(debugRef.current[k]);
                    debugRef.current[k].geometry.dispose();
                    debugRef.current[k].material.dispose();
                }
            });
        };
    }, [camera, scene]);

    useFrame((_, delta) => {
        if (!userData?.vrm) return;
        const vrm = userData.vrm;

        vrm.expressionManager.setValue("angry", angry);
        vrm.expressionManager.setValue("sad", sad);
        vrm.expressionManager.setValue("happy", happy);

        const safeDelta = Math.min(delta, 1 / 30);
        const speed = safeDelta * 12;

        if (riggedFace.current) {
            const face = riggedFace.current;
            rotateBone("neck", face.head, delta * 5, 0.7, -0.7, -0.7);
            rotateBone("head", face.head, delta * 5, 0.7, -0.7, -0.7);

            vrm.expressionManager.setValue("blinkLeft", Math.max(0, 1 - face.eye.r));
            vrm.expressionManager.setValue("blinkRight", Math.max(0, 1 - face.eye.l));

            vrm.expressionManager.setValue("aa", face.mouth.shape.A);
            vrm.expressionManager.setValue("ee", face.mouth.shape.E);
            vrm.expressionManager.setValue("ih", face.mouth.shape.I);
            vrm.expressionManager.setValue("oh", face.mouth.shape.O);
            vrm.expressionManager.setValue("ou", face.mouth.shape.U);
        }

        if (riggedPose.current) {
            rotateBone("chest", riggedPose.current.Spine, delta * 5, 0.3, 0.3, 0.3);
            rotateBone("spine", riggedPose.current.Spine, delta * 5, 0.3, 0.3, 0.3);
            rotateBone("hips", riggedPose.current.Hips.rotation, delta * 5, 0.7, 0.7, 0.7);
        }

        const raw = rawResults.current;
        if (!raw) { vrm.update(delta); return; }

        let debugTargets = { left: null, right: null, leftPole: null, rightPole: null };

        if (raw.poseLandmarks) {
            const pl = raw.poseLandmarks;

            debugTargets.left = applyArmIK(
                "leftUpperArm", "leftLowerArm", "leftHand",
                pl[11], pl[13], pl[15],
                raw.leftHandLandmarks, speed, "left", zSensitivity
            );
            debugTargets.right = applyArmIK(
                "rightUpperArm", "rightLowerArm", "rightHand",
                pl[12], pl[14], pl[16],
                raw.rightHandLandmarks, speed, "right", zSensitivity
            );
        }

        if (raw.leftHandLandmarks) {
            applyWristOrientation("leftHand", "leftLowerArm", raw.leftHandLandmarks, false, speed);
        }
        if (raw.rightHandLandmarks) {
            applyWristOrientation("rightHand", "rightLowerArm", raw.rightHandLandmarks, true, speed);
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

        applyFingers("left", raw.leftHandLandmarks);
        applyFingers("right", raw.rightHandLandmarks);

        // Update debug spheres
        if (showDebug) {
            Object.keys(debugTargets).forEach((k) => {
                const mesh = debugRef.current[k];
                const pos = debugTargets[k];
                if (mesh && pos) {
                    mesh.visible = true;
                    mesh.position.copy(pos);
                } else if (mesh) {
                    mesh.visible = false;
                }
            });
        } else {
            Object.values(debugRef.current).forEach((m) => m && (m.visible = false));
        }

        vrm.update(delta);
    });

    return (
        <group {...props}>
            <primitive object={scene} rotation-y={avatar ? Math.PI : 0} />
        </group>
    );
};