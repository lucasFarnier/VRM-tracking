import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Pose, Hand } from "kalidokit";
import { useControls } from "leva";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpMat = new Matrix4();

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

    const rawResults      = useRef();
    const riggedFace      = useRef();
    const riggedPose      = useRef();

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

    // Points a bone from startLm toward endLm.
    // Works correctly for arms and fingers where only direction matters.
    const applyDirectFK = (boneName, startLm, endLm, slerpFactor) => {
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

        // MediaPipe: X right, Y down, Z toward camera
        // Three.js: X right, Y up, Z toward viewer
        // With scene rotation-y=PI: flip X and Z
        const start = new Vector3( startLm.x, -startLm.y, -startLm.z);
        const end   = new Vector3(   endLm.x,   -endLm.y,   -endLm.z);
        const targetWorldDir = new Vector3().subVectors(end, start).normalize();
        if (targetWorldDir.lengthSq() < 0.001) return;

        const parentWorldQuat = new Quaternion();
        if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuat);
        const targetLocalDir = targetWorldDir.clone().applyQuaternion(parentWorldQuat.clone().invert());

        const rotQuat = new Quaternion().setFromUnitVectors(restDir, targetLocalDir);
        bone.quaternion.slerp(rotQuat, slerpFactor);
    };

    /**
     * applyWristOrientation — full 3-axis palm orientation from hand landmarks.
     *
     * Why 3 landmarks instead of applyDirectFK:
     *   applyDirectFK gives you 1 degree of freedom (which way the bone points).
     *   The wrist needs 3: finger direction, palm facing, and forearm roll.
     *   We get all three by building an orthonormal frame from the palm plane.
     *
     * Coordinate conventions with scene rotation-y=PI (avatar faces toward you):
     *
     *   MediaPipe hand space (looking at your palm, selfie camera):
     *     - Wrist at origin
     *     - Fingers point in +Y (up the image)
     *     - Thumb is on the RIGHT of the image for the LEFT hand (mirrored camera)
     *     - Palm normal points TOWARD camera = +Z
     *
     *   After scene rotation-y=PI, Three.js world space becomes:
     *     - X is flipped: MediaPipe +X (right in image) = world -X
     *     - Z is flipped: MediaPipe +Z (toward camera) = world -Z
     *     - Y stays: MediaPipe -Y (up in image, remember Y-down) = world +Y
     *
     *   VRM normalized hand bone at rest (T-pose, arms out to sides):
     *     - Right hand: fingers point in +X (to the right), palm faces -Z (forward)
     *     - Left hand:  fingers point in -X (to the left),  palm faces -Z (forward)
     *
     * Basis construction:
     *   We use 3 landmarks that reliably span the palm plane:
     *     0  = wrist
     *     5  = index MCP (base of index finger)
     *     17 = pinky MCP (base of pinky)
     *
     *   fingerVec  = normalize(lm[5] - lm[0])   — points along the hand toward fingers
     *   acrossVec  = normalize(lm[17] - lm[5])  — points pinky-ward across knuckles
     *
     *   palmNormal = cross(fingerVec, acrossVec)
     *     For a right hand palm facing you: this gives normal pointing TOWARD you (+Z world).
     *     For a left hand palm facing you:  cross is reversed → normal points AWAY (-Z world).
     *     We negate for left hand so normal always = "out the back of hand".
     *
     *   Then we assign which Three.js axis maps to which palm direction
     *   based on VRM T-pose convention per hand:
     *
     *   Right hand T-pose: fingers = +X, palm-back = +Y, thumb-up = +Z
     *     basisX = fingerVec   (along fingers)
     *     basisY = palmNormal  (back of hand)
     *     basisZ = cross(X,Y)  (thumb direction)
     *
     *   Left hand T-pose: fingers = -X, palm-back = +Y, thumb-up = -Z
     *     We negate fingerVec and acrossVec so the basis is consistent
     *     basisX = -fingerVec
     *     basisY = palmNormal (already negated above)
     *     basisZ = cross(X,Y)
     *
     *   This gives us a rotation matrix in world space.
     *   Convert to the hand bone's local space: localQ = inv(lowerArm_world) * worldQ
     */
    const applyWristOrientation = (boneName, lowerArmName, landmarks, isRight, slerpFactor) => {
        if (!landmarks || landmarks.length < 21) return;
        const bone     = userData.vrm?.humanoid.getNormalizedBoneNode(boneName);
        const lowerArm = userData.vrm?.humanoid.getNormalizedBoneNode(lowerArmName);
        if (!bone || !lowerArm) return;

        const lm = landmarks;

        // Convert from MediaPipe space to Three.js world space.
        // scene rotation-y=PI means X and Z are negated relative to camera space.
        const toWorld = (l) => new Vector3(l.x, -l.y, -l.z);

        const wrist    = toWorld(lm[0]);
        const indexMcp = toWorld(lm[5]);
        const pinkyMcp = toWorld(lm[17]);

        // fingerVec: wrist → index knuckle (along the finger direction)
        const fingerVec = new Vector3().subVectors(indexMcp, wrist).normalize();
        // acrossVec: index knuckle → pinky knuckle (across the palm)
        const acrossVec = new Vector3().subVectors(pinkyMcp, indexMcp).normalize();

        // palmNormal: perpendicular to palm surface, pointing out the BACK of the hand.
        // cross(finger, across) for right hand naturally points toward you (palm facing camera).
        // For the back-of-hand direction we want the opposite, so negate for right, keep for left.
        // Then flip for left hand so it's consistent.
        let palmNormal;
        if (isRight) {
            // Right hand: cross(finger, across) points toward camera = palm side.
            // Negate to get back-of-hand direction.
            palmNormal = new Vector3().crossVectors(fingerVec, acrossVec).normalize().negate();
        } else {
            // Left hand: cross(finger, across) already points away from camera = back of hand.
            palmNormal = new Vector3().crossVectors(fingerVec, acrossVec).normalize();
        }

        // Build basis vectors matching VRM T-pose hand orientation.
        // Right hand at rest: +X = fingers, +Y = back of hand, +Z = thumb side
        // Left  hand at rest: -X = fingers, +Y = back of hand, -Z = thumb side
        // We unify this by pointing basisX along fingers (and negating for left),
        // basisY = palmNormal, basisZ = cross(basisX, basisY).
        let basisX = isRight ? fingerVec.clone() : fingerVec.clone().negate();
        const basisY = palmNormal.clone();
        // Re-orthogonalise: basisZ perpendicular to both X and Y
        const basisZ = new Vector3().crossVectors(basisX, basisY).normalize();
        // Re-derive basisX from Y and Z to guarantee orthonormality
        basisX = new Vector3().crossVectors(basisY, basisZ).normalize();

        tmpMat.makeBasis(basisX, basisY, basisZ);
        const worldQuat = new Quaternion().setFromRotationMatrix(tmpMat);

        // Convert from world space into the lowerArm bone's local space.
        // lowerArm is the parent of the hand bone in VRM humanoid hierarchy.
        const lowerArmWorldQuat = new Quaternion();
        lowerArm.getWorldQuaternion(lowerArmWorldQuat);
        const localQuat = lowerArmWorldQuat.clone().invert().multiply(worldQuat);

        bone.quaternion.slerp(localQuat, slerpFactor);
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

        // Arms: direct FK from pose landmarks (no Kalidokit, no crossing)
        if (raw.poseLandmarks) {
            const pl = raw.poseLandmarks;
            applyDirectFK("leftUpperArm",  pl[11], pl[13], speed);
            applyDirectFK("leftLowerArm",  pl[13], pl[15], speed);
            applyDirectFK("rightUpperArm", pl[12], pl[14], speed);
            applyDirectFK("rightLowerArm", pl[14], pl[16], speed);
        }

        // Wrists: full palm-basis orientation from hand landmarks
        if (raw.leftHandLandmarks) {
            applyWristOrientation("leftHand",  "leftLowerArm",  raw.leftHandLandmarks,  false, speed);
        }
        if (raw.rightHandLandmarks) {
            applyWristOrientation("rightHand", "rightLowerArm", raw.rightHandLandmarks, true,  speed);
        }

        // Fingers: direct FK per segment from raw hand landmarks
        const applyFingers = (prefix, lms) => {
            if (!lms) return;
            applyDirectFK(`${prefix}ThumbProximal`,      lms[1],  lms[2],  speed);
            applyDirectFK(`${prefix}ThumbMetacarpal`,    lms[2],  lms[3],  speed);
            applyDirectFK(`${prefix}ThumbDistal`,        lms[3],  lms[4],  speed);
            applyDirectFK(`${prefix}IndexProximal`,      lms[5],  lms[6],  speed);
            applyDirectFK(`${prefix}IndexIntermediate`,  lms[6],  lms[7],  speed);
            applyDirectFK(`${prefix}IndexDistal`,        lms[7],  lms[8],  speed);
            applyDirectFK(`${prefix}MiddleProximal`,     lms[9],  lms[10], speed);
            applyDirectFK(`${prefix}MiddleIntermediate`, lms[10], lms[11], speed);
            applyDirectFK(`${prefix}MiddleDistal`,       lms[11], lms[12], speed);
            applyDirectFK(`${prefix}RingProximal`,       lms[13], lms[14], speed);
            applyDirectFK(`${prefix}RingIntermediate`,   lms[14], lms[15], speed);
            applyDirectFK(`${prefix}RingDistal`,         lms[15], lms[16], speed);
            applyDirectFK(`${prefix}LittleProximal`,     lms[17], lms[18], speed);
            applyDirectFK(`${prefix}LittleIntermediate`, lms[18], lms[19], speed);
            applyDirectFK(`${prefix}LittleDistal`,       lms[19], lms[20], speed);
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
//works better but thumb on wrong side of the hand